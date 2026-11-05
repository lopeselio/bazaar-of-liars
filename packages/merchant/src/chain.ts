/**
 * The `bazaar` contract on NEAR (contracts/bazaar).
 *   Ledger      — the game server's writes: open_haggle (commit) and close_haggle (reveal + settle).
 *   ChainReader — keyless reads the verifier uses to check a bundle against the chain.
 *
 * The server key is read from ~/.near-credentials (near-cli-rs legacy keychain) or from
 * SERVER_PRIVATE_KEY for a hosted deploy. It is never logged or written to a bundle.
 */
import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import type { MerchantSecret } from "@bazaar/core";

export type Network = "testnet" | "mainnet";

const RPC: Record<Network, string> = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};
export const explorerTx = (network: Network, hash: string) =>
  `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;

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

export interface Ledger {
  readonly network: Network;
  readonly contractId: string;
  readonly serverId: string;
  open(a: {
    haggleId: string;
    player: string;
    side: "sell" | "buy";
    merchantId: string;
    goodId: string;
    grudge: number;
    loyalty: number;
    commitment: string;
  }): Promise<string>;
  close(a: { haggleId: string; secret: MerchantSecret; salt: string; dealPrice: number | null; lowballed: boolean }): Promise<string>;
}

export function nearLedger(cfg: { network: Network; contractId: string; serverId: string; privateKey?: string }): Ledger {
  const near = new Near({
    network: cfg.network,
    rpcUrl: RPC[cfg.network],
    defaultSignerId: cfg.serverId,
    ...(cfg.privateKey
      ? { privateKey: cfg.privateKey as `ed25519:${string}` }
      : { keyStore: new FileKeyStore("~/.near-credentials", cfg.network) }),
  });
  // open: optimistic (the haggle starts sooner; its block time is what the verifier checks).
  // close: FINAL, so anyone reading the reveal right after sees it.
  const call = async (method: string, args: object, waitUntil: "EXECUTED_OPTIMISTIC" | "FINAL" = "EXECUTED_OPTIMISTIC") => {
    const r = await near
      .transaction(cfg.serverId)
      .functionCall(cfg.contractId, method, args, { gas: "30 Tgas" })
      .send({ waitUntil });
    return r.transaction.hash as string;
  };
  return {
    network: cfg.network,
    contractId: cfg.contractId,
    serverId: cfg.serverId,
    open: (a) =>
      call("open_haggle", {
        haggle_id: a.haggleId,
        player: a.player,
        side: a.side,
        merchant_id: a.merchantId,
        good_id: a.goodId,
        grudge: a.grudge,
        loyalty: a.loyalty,
        commitment: a.commitment,
      }),
    close: (a) =>
      call("close_haggle", { haggle_id: a.haggleId, secret: a.secret, salt: a.salt, deal_price: a.dealPrice, lowballed: a.lowballed }, "FINAL"),
  };
}

/** Ledger from env (BAZAAR_CONTRACT_ID, SERVER_ACCOUNT_ID, optional SERVER_PRIVATE_KEY), or null if unset. */
export function ledgerFromEnv(env = process.env): Ledger | null {
  if (!env.BAZAAR_CONTRACT_ID || !env.SERVER_ACCOUNT_ID) return null;
  return nearLedger({
    network: (env.NEAR_NETWORK as Network) ?? "testnet",
    contractId: env.BAZAAR_CONTRACT_ID,
    serverId: env.SERVER_ACCOUNT_ID,
    privateKey: env.SERVER_PRIVATE_KEY || undefined,
  });
}

// ---------- reads (no key) ----------

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

export interface ChainReader {
  getHaggle(network: Network, contractId: string, haggleId: string): Promise<OnchainHaggle | null>;
  /** Timestamp (ms) of the block that included the transaction, and who signed it. */
  txInfo(network: Network, txHash: string, signerId: string): Promise<{ blockTimeMs: number; signerId: string; receiverId: string }>;
}

async function rpc<T>(network: Network, method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "bazaar", method, params }),
  });
  const j = (await res.json()) as { result?: T; error?: { message?: string; cause?: { name?: string } } };
  if (!j.result) throw new Error(`${method}: ${j.error?.cause?.name ?? j.error?.message ?? res.status}`);
  return j.result;
}

export const nearReader: ChainReader = {
  async getHaggle(network, contractId, haggleId) {
    const near = new Near({ network, rpcUrl: RPC[network] });
    return (await near.view<OnchainHaggle | null>(contractId, "get_haggle", { haggle_id: haggleId })) ?? null;
  },
  async txInfo(network, txHash, signerId) {
    const tx = await rpc<{ transaction: { signer_id: string; receiver_id: string }; transaction_outcome: { block_hash: string } }>(
      network,
      "tx",
      { tx_hash: txHash, sender_account_id: signerId, wait_until: "EXECUTED_OPTIMISTIC" },
    );
    const block = await rpc<{ header: { timestamp_nanosec: string } }>(network, "block", { block_id: tx.transaction_outcome.block_hash });
    return {
      blockTimeMs: Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n),
      signerId: tx.transaction.signer_id,
      receiverId: tx.transaction.receiver_id,
    };
  },
};

export interface PlayerState {
  known: boolean;
  coins: number;
  goods: number[];
}

/** Keyless read of a player's coins and goods from the contract. */
export async function readPlayer(network: Network, contractId: string, player: string, goodIds: string[]): Promise<PlayerState> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  // Optimistic finality: the UI should reflect a deal the moment it executes.
  const st = await near.view<PlayerState>(contractId, "player_state", { player, good_ids: goodIds }, { finality: "optimistic" });
  return st ?? { known: false, coins: 0, goods: goodIds.map(() => 0) };
}

export interface Memory {
  lowballs: number;
  deals: number;
}

/** What a merchant remembers about a player, from the contract. */
export async function readMemory(network: Network, contractId: string, player: string, merchantId: string): Promise<Memory> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<Memory>(contractId, "memory_of", { player, merchant_id: merchantId }, { finality: "optimistic" })) ?? { lowballs: 0, deals: 0 };
}

export async function readLeaderboard(network: Network, contractId: string): Promise<{ player: string; peak: number }[]> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<{ player: string; peak: number }[]>(contractId, "leaderboard", {}, { finality: "optimistic" })) ?? [];
}
