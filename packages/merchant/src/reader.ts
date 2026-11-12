/**
 * Keyless reads of the bazaar contract and of transactions, using only fetch, so the proof verifier
 * runs unchanged in Node and in a browser. (chain.ts, which also signs, re-exports all of this.)
 */
import type { MerchantSecret } from "@bazaar/core";
import { archivalRpcUrls, installRpcFailover, primaryRpc, rpcRefusal, type Network } from "@bazaar/verify";

// A busy RPC (HTTP 429) falls over to the next public endpoint: see packages/verify/src/rpc.ts.
installRpcFailover();
export const RPC: Record<Network, string> = { testnet: primaryRpc("testnet"), mainnet: primaryRpc("mainnet") };

/** What a bundle records about its onchain life. */
export interface ChainRecord {
  network: Network;
  contractId: string;
  serverId: string;
  player: string;
  openTx: string;
  closeTx: string | null;
  closeError?: string;
}

export interface OnchainHaggle {
  player: string;
  side: "sell" | "buy";
  grudge: number;
  loyalty: number;
  merchant_id: string;
  good_id: string;
  commitment: string;
  opened_block: number;
  status: "open" | "deal" | "no_deal" | "expired";
  price: number | null;
  secret: MerchantSecret | null;
  salt: string | null;
}

export interface TxInfo {
  blockTimeMs: number;
  signerId: string;
  receiverId: string;
  /** The transaction's function calls, with JSON args (null if not JSON). */
  calls?: Array<{ method: string; args: Record<string, unknown> | null }>;
  /** The transaction and the contract's receipt both succeeded. */
  ok?: boolean;
  /** Height of the block where the contract executed it. */
  blockHeight?: number;
}

export interface ChainReader {
  getHaggle(network: Network, contractId: string, haggleId: string): Promise<OnchainHaggle | null>;
  /**
   * Who signed the transaction, its function calls, whether it succeeded, and the time (ms) of
   * the block where the contract executed it (when its effects, e.g. a commitment, were onchain).
   */
  txInfo(network: Network, txHash: string, signerId: string): Promise<TxInfo>;
}

/** Errors that mean "this node no longer has it": ask an archival node instead. */
const PRUNED = new Set(["UNKNOWN_TRANSACTION", "UNKNOWN_BLOCK", "GARBAGE_COLLECTED_BLOCK", "TIMEOUT_ERROR"]);

async function rpcAt<T>(url: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "bazaar", method, params }),
  });
  const j = (await res.json().catch(() => ({}))) as { result?: T; error?: { code?: number; message?: string; cause?: { name?: string } } };
  const refusal = rpcRefusal(res.status, j);
  if (refusal) throw Object.assign(new Error(`${method}: ${refusal}`), { cause: "RPC_REFUSED" });
  if (!j.result) throw Object.assign(new Error(`${method}: ${j.error?.cause?.name ?? j.error?.message ?? res.status}`), { cause: j.error?.cause?.name });
  return j.result;
}

/** A keyless read: the regular RPC first, then archival nodes for history it has pruned. */
export async function rpc<T>(network: Network, method: string, params: unknown): Promise<T> {
  try {
    return await rpcAt<T>(RPC[network], method, params);
  } catch (e) {
    if (!PRUNED.has(String((e as Error & { cause?: unknown }).cause))) throw e;
    let last = e;
    for (const url of archivalRpcUrls(network)) {
      try {
        return await rpcAt<T>(url, method, params);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }
}

/** An object once final; a string ("Started", "NotStarted", "Unknown") while in flight. */
type Status = { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown } | string;
const succeeded = (st: Status | undefined) => typeof st === "object" && st !== null && ("SuccessValue" in st || "SuccessReceiptId" in st);
type TxResult = {
  transaction: { signer_id: string; receiver_id: string; actions?: Array<{ FunctionCall?: { method_name: string; args: string } } | string> };
  transaction_outcome?: { block_hash: string; outcome?: { receipt_ids?: string[] } };
  receipts_outcome?: Array<{ id: string; block_hash: string; outcome: { executor_id: string; status: Status } }>;
  status?: Status;
};
const jsonArgs = (b64: string) => {
  try {
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export const nearReader: ChainReader = {
  async getHaggle(network, contractId, haggleId) {
    return viewCall<OnchainHaggle | null>(network, contractId, "get_haggle", { haggle_id: haggleId });
  },
  async txInfo(network, txHash, signerId) {
    // Don't wait: a node asked to wait for a transaction it has pruned waits until it times out.
    // A transaction still executing has no outcome yet; only then wait for it.
    let tx = await rpc<TxResult>(network, "tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "NONE" });
    // The contract's own receipt: its block is when the call's effects were onchain.
    const contractReceipt = (t: TxResult) => {
      const first = t.transaction_outcome?.outcome?.receipt_ids?.[0];
      return t.receipts_outcome?.find((r) => r.id === first) ?? t.receipts_outcome?.find((r) => r.outcome.executor_id === t.transaction.receiver_id);
    };
    if (!tx.transaction_outcome || !contractReceipt(tx))
      tx = await rpc<TxResult>(network, "tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "EXECUTED_OPTIMISTIC" });
    if (!tx.transaction_outcome) throw new Error("tx: no outcome yet");
    const receipt = contractReceipt(tx);
    const block = await rpc<{ header: { timestamp_nanosec: string; height: number } }>(network, "block", { block_id: (receipt ?? tx.transaction_outcome).block_hash });
    const calls = (tx.transaction.actions ?? []).flatMap((a) => (typeof a === "object" && a.FunctionCall ? [{ method: a.FunctionCall.method_name, args: jsonArgs(a.FunctionCall.args) }] : []));
    return {
      blockTimeMs: Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n),
      signerId: tx.transaction.signer_id,
      receiverId: tx.transaction.receiver_id,
      calls,
      ok: succeeded(tx.status) && !!receipt && succeeded(receipt.outcome.status),
      ...(receipt ? { blockHeight: block.header.height } : {}),
    };
  },
};


/** A contract view call (final), decoded from JSON. */
export async function viewCall<T>(network: Network, contractId: string, method: string, args: object): Promise<T> {
  const argsB64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
  const r = await rpc<{ result: number[] }>(network, "query", { request_type: "call_function", finality: "final", account_id: contractId, method_name: method, args_base64: argsB64 });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
}
