/**
 * Signing in with a NEAR wallet (MyNearWallet, Meteor, …) by NEP-413 signed message.
 *
 * NEAR Auth (Google/email) only works where NEAR's team has allowed the site's domain, so the
 * hosted demo also offers this: we hand out a one-time 32-byte nonce, the wallet signs
 * `{ message, nonce, recipient }` with the account's full-access key (NEP-413), and we check
 *   1. the nonce is one we issued, unused, and not expired;
 *   2. the ed25519 signature over sha256(tag ‖ borsh(payload)), tag = 2^31 + 413;
 *   3. that public key is a FULL-ACCESS key of the claimed account, read from the chain.
 * Then the player is that account. Nothing here can sign for the user.
 */
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

import { NAMED_RE, base58Decode } from "./auth.js";

export const SIGN_IN_MESSAGE = "Sign in to Bazaar of Liars";
const NEP413_TAG = 2 ** 31 + 413;

export const newNonce = () => randomBytes(32);

function borshString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

/** The bytes a NEP-413 wallet signs: sha256(u32 tag ‖ borsh({message, nonce, recipient, callbackUrl})). */
export function nep413Hash(p: { message: string; nonce: Buffer; recipient: string; callbackUrl?: string | null }): Buffer {
  if (p.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const cb = p.callbackUrl == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(p.callbackUrl)]);
  return createHash("sha256").update(Buffer.concat([tag, borshString(p.message), p.nonce, borshString(p.recipient), cb])).digest();
}

/** Check an ed25519 signature ("ed25519:<b58>" key; signature base64 or "ed25519:<b58>"). */
export function verifyEd25519(publicKey: string, message: Buffer, signature: string): boolean {
  try {
    const [type, b58] = publicKey.split(":");
    if (type !== "ed25519" || !b58) return false;
    const raw = base58Decode(b58);
    if (raw.length !== 32) return false;
    const sig = signature.startsWith("ed25519:") ? base58Decode(signature.slice(8)) : Buffer.from(signature, "base64");
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    return verify(null, message, key, sig);
  } catch {
    return false; // malformed key or signature: not a valid signature
  }
}

export type KeyReader = (accountId: string, publicKey: string) => Promise<"full" | "function-call" | "none">;

/** Is this key on the account, and with what permission? (view_access_key over RPC) */
export function rpcKeyReader(rpcUrl: string): KeyReader {
  return async (accountId, publicKey) => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }),
    });
    // A missing key comes back as { result: { error: "access key … does not exist" } }, not as an RPC error.
    if (!res.ok) throw new WalletRpcError(`RPC answered ${res.status}`);
    const j = (await res.json().catch(() => {
      throw new WalletRpcError("RPC returned something that isn't JSON");
    })) as { result?: { permission?: "FullAccess" | object; error?: string }; error?: unknown };
    const perm = j.result?.permission;
    if (!perm) return "none";
    return perm === "FullAccess" ? "full" : "function-call";
  };
}

/**
 * A sign-in is for one site: the challenge records the host it was asked from, the wallet signs
 * with that host as the NEP-413 recipient (and shows it), and the wallet must return the signature
 * to a page on that same host. A signature collected by another site can't be replayed here.
 */
export interface Challenge {
  recipient: string;
}

export interface WalletProof {
  accountId: string;
  publicKey: string;
  signature: string;
  /** base64 of the 32-byte nonce we issued. */
  nonce: string;
  callbackUrl?: string | null;
}

export class WalletAuthError extends Error {}
/** The chain couldn't be asked (rate limit, outage): try again, not "denied". */
export class WalletRpcError extends Error {}

/**
 * Check a signed sign-in message. `consumeNonce` must return true exactly once for a nonce we
 * issued and haven't seen used (the server keeps them in the store with a short TTL).
 */
export async function verifyWalletSignIn(
  p: WalletProof,
  challenge: (nonceB64: string) => Promise<Challenge | null>,
  consumeNonce: (nonceB64: string) => Promise<boolean>,
  keys: KeyReader,
): Promise<string> {
  const isImplicit = /^[0-9a-f]{64}$/.test(p.accountId);
  if (!isImplicit && !NAMED_RE.test(p.accountId)) throw new WalletAuthError("that isn't a NEAR account id");
  const nonce = Buffer.from(p.nonce ?? "", "base64");
  if (nonce.length !== 32) throw new WalletAuthError("bad nonce");
  const ch = await challenge(p.nonce);
  if (!ch) throw new WalletAuthError("this sign-in request expired; try again");
  let back: URL;
  try {
    back = new URL(p.callbackUrl ?? "");
  } catch {
    throw new WalletAuthError("the wallet must return to this site");
  }
  if (back.host !== ch.recipient) throw new WalletAuthError("the wallet must return to this site");
  // Wallets differ on whether the callback URL is part of the signed payload; both forms bind the
  // same nonce, message and recipient, so accept either.
  const forms = [p.callbackUrl ?? null, null];
  const ok = forms.some((callbackUrl) => verifyEd25519(p.publicKey, nep413Hash({ message: SIGN_IN_MESSAGE, nonce, recipient: ch.recipient, callbackUrl }), p.signature));
  if (!ok) throw new WalletAuthError("the signature doesn't match");
  // Only a valid signature uses the nonce up, so a bad attempt can't burn someone's sign-in.
  if (!(await consumeNonce(p.nonce))) throw new WalletAuthError("this sign-in request was already used; try again");
  const perm = await keys(p.accountId, p.publicKey);
  if (perm !== "full") throw new WalletAuthError(perm === "none" ? "that key isn't on the account" : "sign in with a full-access key");
  return p.accountId;
}
