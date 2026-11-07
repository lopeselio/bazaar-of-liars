/**
 * Deed certificates (contract v3.12): check, with nothing but Ethereum's own rules, that the
 * bazaar's NEAR contract says who owns a stall deed.
 *
 * The contract asks NEAR's MPC network (Chain Signatures) to sign an Ethereum personal message
 * (EIP-191) with a secp256k1 key derived for (the contract's account, "bazaar-deeds"). Only that
 * contract can sign with that key. So if the signature recovers to the key's Ethereum address,
 * the contract said it, and any EVM contract can check the same thing with `ecrecover`.
 */
import { computeAddress, decodeBase58, toBeHex, verifyMessage } from "ethers";

export const DEED_KEY_PATH = "bazaar-deeds";

export interface DeedCertificate {
  slot: string;
  owner: string;
  message: string;
  /** 65-byte Ethereum signature, 0x r ‖ s ‖ v. */
  signature: string;
  block_height: number;
}

/** The words a certificate signs. MUST match `deed_message` in contracts/bazaar. */
export const deedMessage = (slot: string, owner: string, contract: string, blockHeight: number) =>
  `Bazaar of Liars deed ${slot} (NEAR contract ${contract}) is owned by ${owner} as of NEAR block ${blockHeight}.`;

/** The Ethereum address of a NEAR MPC public key ("secp256k1:<base58 of x‖y>"). */
export function ethAddressOf(nearKey: string): string {
  const [curve, b58] = nearKey.split(":");
  if (curve !== "secp256k1" || !b58) throw new Error(`not a secp256k1 key: ${nearKey}`);
  return computeAddress(`0x04${toBeHex(decodeBase58(b58), 64).slice(2)}`);
}

export interface DeedCheck {
  ok: boolean;
  label: string;
  detail: string;
}

/** Offline checks of a certificate against the bazaar's Ethereum address. */
export function checkDeedCertificate(cert: DeedCertificate, a: { contractId: string; ethAddress: string; currentOwner?: string | null }): DeedCheck[] {
  let recovered = "";
  try {
    recovered = verifyMessage(cert.message, cert.signature);
  } catch (e) {
    recovered = `(${(e as Error).message.slice(0, 60)})`;
  }
  const expected = deedMessage(cert.slot, cert.owner, a.contractId, cert.block_height);
  const checks: DeedCheck[] = [
    { ok: recovered.toLowerCase() === a.ethAddress.toLowerCase(), label: "Signature recovers to the bazaar's Ethereum address", detail: `${recovered} vs ${a.ethAddress}` },
    { ok: cert.message === expected, label: "The message names this deed, owner, contract and block", detail: cert.message },
  ];
  if (a.currentOwner !== undefined)
    checks.push({ ok: a.currentOwner === cert.owner, label: "The certified owner still owns the deed", detail: a.currentOwner ? `owner now: ${a.currentOwner}` : "the deed no longer exists" });
  return checks;
}

const RPC: Record<string, string> = { testnet: process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com", mainnet: process.env.NEAR_RPC_URL ?? "https://rpc.mainnet.fastnear.com" };

async function view<T>(network: string, account: string, method: string, args: object): Promise<T> {
  const r = await fetch(RPC[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
  });
  const j = (await r.json()) as { result?: { result: number[] }; error?: unknown };
  if (!j.result) throw new Error(`${account}.${method}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
  return JSON.parse(Buffer.from(j.result.result).toString()) as T;
}

/** The bazaar's Ethereum address: from the MPC signer's key derived for the contract. */
export async function deedSignerAddress(network: string, contractId: string): Promise<{ signer: string; path: string; publicKey: string; ethAddress: string }> {
  const [signer, path] = await view<[string, string]>(network, contractId, "deed_signer", {});
  const publicKey = await view<string>(network, signer, "derived_public_key", { path, predecessor: contractId, domain_id: 0 });
  return { signer, path, publicKey, ethAddress: ethAddressOf(publicKey) };
}

/** Read a deed's certificate and its current owner from the chain, and check it. */
export async function verifyDeedOnchain(network: string, contractId: string, slot: string) {
  const cert = await view<DeedCertificate | null>(network, contractId, "deed_certificate", { slot });
  const key = await deedSignerAddress(network, contractId);
  const token = await view<{ owner_id: string } | null>(network, contractId, "nft_token", { token_id: slot });
  return { cert, ...key, checks: cert ? checkDeedCertificate(cert, { contractId, ethAddress: key.ethAddress, currentOwner: token?.owner_id ?? null }) : [] };
}
