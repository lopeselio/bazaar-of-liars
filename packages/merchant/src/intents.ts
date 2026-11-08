/**
 * NEAR Intents: agents barter goods through the Intents Verifier (our testnet deployment of the
 * open-source near/intents contract, `bazaar-intents.testnet`).
 *
 * Each agent's identity in the Verifier is the implicit account of its own key, so only that key
 * can sign its intents. An intent is a NEP-413 signed message:
 *   { signer_id, deadline, intents: [ { intent: "token_diff", diff }, { intent: "mt_withdraw", … } ] }
 * with recipient = the Verifier and a versioned nonce:
 *   5628f6c6 ‖ 0x00 ‖ salt (4, from `current_salt`) ‖ deadline (u64 LE ns) ‖ 15 random bytes.
 * The Verifier checks every signature and that each token's diffs sum to zero across the batch,
 * then moves the goods; `mt_withdraw` sends them back to the agent's account in the game contract.
 */
import { parseKey } from "near-kit";
import { base58Decode, base58Encode } from "@bazaar/verify";
import type { Network } from "@bazaar/verify";
import { rpc } from "./reader.js";

export const NONCE_PREFIX = "5628f6c6";

/** The Verifier's id for one of the game's goods (NEP-245 on the game contract). */
export const tokenId = (gameContract: string, good: string) => `nep245:${gameContract}:${good}`;

/** "ed25519:<b58>" → the implicit account (64 hex) that key controls. */
export function implicitOf(publicKey: string): string {
  const [type, b58] = publicKey.split(":");
  if (type !== "ed25519" || !b58) throw new Error("expected an ed25519 key");
  return Buffer.from(base58Decode(b58)).toString("hex");
}

export function versionedNonce(saltHex: string, deadline: Date, random = globalThis.crypto.getRandomValues(new Uint8Array(15))): Buffer {
  const n = Buffer.alloc(32);
  Buffer.from(NONCE_PREFIX, "hex").copy(n, 0);
  n[4] = 0; // VersionedNonce::V1
  Buffer.from(saltHex, "hex").copy(n, 5);
  n.writeBigUInt64LE(BigInt(deadline.getTime()) * 1_000_000n, 9);
  Buffer.from(random).copy(n, 17);
  return n;
}

export type Intent =
  | { intent: "token_diff"; diff: Record<string, string>; memo?: string }
  | { intent: "mt_withdraw"; token: string; receiver_id: string; token_ids: string[]; amounts: string[]; memo?: string };

/** A signed intent in the Verifier's MultiPayload form (NEP-413 standard). */
export interface SignedIntent {
  standard: "nep413";
  payload: { recipient: string; nonce: string; message: string };
  public_key: string;
  signature: string;
}

/** Sign intents with an agent's key; the signer is that key's implicit account. */
export function signIntents(o: { privateKey: string; verifier: string; saltHex: string; intents: Intent[]; ttlMs?: number; now?: number }): SignedIntent {
  const key = parseKey(o.privateKey);
  const signerId = implicitOf(key.publicKey.toString());
  const deadline = new Date((o.now ?? Date.now()) + (o.ttlMs ?? 5 * 60_000));
  const nonce = versionedNonce(o.saltHex, deadline);
  const message = JSON.stringify({ signer_id: signerId, deadline: deadline.toISOString(), intents: o.intents });
  const s = key.signNep413Message!(signerId, { message, recipient: o.verifier, nonce });
  // near-kit returns the signature in base64; the Verifier wants "ed25519:<base58>".
  const signature = s.signature.startsWith("ed25519:") ? s.signature : `ed25519:${base58Encode(Buffer.from(s.signature, "base64"))}`;
  return { standard: "nep413", payload: { recipient: o.verifier, nonce: nonce.toString("base64"), message }, public_key: s.publicKey, signature };
}

async function view<T>(network: Network, contract: string, method: string, args: object): Promise<T> {
  const r = await rpc<{ result: number[] }>(network, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
}

export const readSalt = (network: Network, verifier: string) => view<string>(network, verifier, "current_salt", {});

/** Dry-run a batch: throws with the Verifier's reason if it would fail, including unbalanced diffs. */
export async function simulateIntents(network: Network, verifier: string, signed: SignedIntent[]): Promise<unknown> {
  const out = await view<{ invariant_violated?: unknown }>(network, verifier, "simulate_intents", { signed });
  if (out && typeof out === "object" && out.invariant_violated) throw new Error(`intents would not balance: ${JSON.stringify(out.invariant_violated)}`);
  return out;
}

/** An agent's whole balance of the game's goods in the Verifier, by good. */
export async function intentsHoldings(network: Network, verifier: string, gameContract: string, identity: string, goods: string[]): Promise<Record<string, number>> {
  const ids = goods.map((g) => tokenId(gameContract, g));
  const bal = await view<string[]>(network, verifier, "mt_batch_balance_of", { account_id: identity, token_ids: ids });
  return Object.fromEntries(goods.map((g, i) => [g, Number(bal[i] ?? 0)]));
}

export const intentsBalance = (network: Network, verifier: string, account: string, token: string) =>
  view<string>(network, verifier, "mt_balance_of", { account_id: account, token_id: token }).then(Number);

/** The two sides of a barter: each gives some of one good and receives some of another. */
export interface BarterSide {
  agentAccount: string;
  privateKey: string;
  give: { good: string; qty: number };
  get: { good: string; qty: number };
}

/**
 * Both agents' signed intents for one barter: each signs its own token_diff (−give, +get), then
 * withdraws what it got back to its account in the game. Their diffs cancel, so the Verifier settles
 * them together or not at all.
 */
/** One side's intents: give `give`, receive `get`, and withdraw what it got back to the game. */
export function barterSide(gameContract: string, give: { good: string; qty: number }, get: { good: string; qty: number }, receiver: string, memo?: string): Intent[] {
  return [
    { intent: "token_diff", diff: { [tokenId(gameContract, give.good)]: String(-give.qty), [tokenId(gameContract, get.good)]: String(get.qty) }, ...(memo ? { memo } : {}) },
    { intent: "mt_withdraw", token: gameContract, receiver_id: receiver, token_ids: [get.good], amounts: [String(get.qty)] },
  ];
}

/** Take a deposit back out (when a barter didn't settle). */
export const withdrawBack = (gameContract: string, good: string, qty: number, receiver: string): Intent[] => [
  { intent: "mt_withdraw", token: gameContract, receiver_id: receiver, token_ids: [good], amounts: [String(qty)] },
];

export function barterIntents(o: { gameContract: string; verifier: string; saltHex: string; a: BarterSide; b: BarterSide; memo?: string }): SignedIntent[] {
  const side = (s: BarterSide) =>
    signIntents({
      privateKey: s.privateKey,
      verifier: o.verifier,
      saltHex: o.saltHex,
      intents: [
        {
          intent: "token_diff",
          diff: { [tokenId(o.gameContract, s.give.good)]: String(-s.give.qty), [tokenId(o.gameContract, s.get.good)]: String(s.get.qty) },
          ...(o.memo ? { memo: o.memo } : {}),
        },
        { intent: "mt_withdraw", token: o.gameContract, receiver_id: s.agentAccount, token_ids: [s.get.good], amounts: [String(s.get.qty)] },
      ],
    });
  return [side(o.a), side(o.b)];
}

/** What the game contract has registered: the Verifier, and an agent's identity there. */
export const readIntentsVerifier = (network: Network, gameContract: string) => view<string | null>(network, gameContract, "intents_verifier", {});
export const readIntentsIdentity = (network: Network, gameContract: string, agentId: string) =>
  view<string | null>(network, gameContract, "intents_of", { agent_id: agentId });
