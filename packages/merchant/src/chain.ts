/**
 * The `bazaar` contract on NEAR (contracts/bazaar).
 *   Ledger      — the game server's writes: open_haggle (commit) and close_haggle (reveal + settle).
 *   ChainReader — keyless reads the verifier uses to check a bundle against the chain.
 *
 *   AgentSigner — an agent signing for itself (v3): authorize_spend and pay_agent, with its own
 *                 function-call key. The server can't spend an agent's coins without it.
 *
 * The server key is read from ~/.near-credentials (near-cli-rs legacy keychain) or from
 * SERVER_PRIVATE_KEY for a hosted deploy; agent keys likewise, or from AGENT_KEYS (a JSON map of
 * account → private key). Keys are never logged or written to a bundle.
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
    /** Units in the lot (v3; default 1). */
    qty?: number;
    /** Coins locked from a buying merchant's purse (v3; required when it buys). */
    escrow?: number;
  }): Promise<string>;
  close(a: { haggleId: string; secret: MerchantSecret; salt: string; dealPrice: number | null; lowballed: boolean }): Promise<string>;
  /** v3: a player puts coins into an agent. */
  invest?(a: { player: string; agentId: string; amount: number }): Promise<string>;
  /** v3: a merchant uses up a good it bought. */
  consume?(a: { agentId: string; goodId: string; qty: number }): Promise<string>;
  /** v3.1: a customer's business brings in coins (capped per day by the contract). */
  payIncome?(a: { agentId: string; amount: number }): Promise<string>;
  /** v3.1: a player delivered; pays the bounty, and any fare to the cab company. */
  fulfilOrder?(a: { orderId: string; player: string; fare: number }): Promise<string>;
  /** v3.1: refund an order past its deadline (anyone may). */
  expireOrder?(orderId: string): Promise<string>;
  pruneOrders?(orderIds: string[]): Promise<string>;
  /** v3.2: XP for what only the server sees (a caught bluff), capped per day by the contract. */
  awardCred?(a: { player: string; xp: number; reason: string }): Promise<string>;
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
        ...(a.qty !== undefined || a.escrow !== undefined ? { qty: a.qty ?? null, escrow: a.escrow ?? null } : {}),
      }),
    close: (a) =>
      call("close_haggle", { haggle_id: a.haggleId, secret: a.secret, salt: a.salt, deal_price: a.dealPrice, lowballed: a.lowballed }, "FINAL"),
    invest: (a) => call("invest", { player: a.player, agent_id: a.agentId, amount: a.amount }, "FINAL"),
    consume: (a) => call("consume", { agent_id: a.agentId, good_id: a.goodId, qty: a.qty }),
    payIncome: (a) => call("pay_income", { agent_id: a.agentId, amount: a.amount }),
    fulfilOrder: (a) => call("fulfil_order", { order_id: a.orderId, player: a.player, fare: a.fare }, "FINAL"),
    expireOrder: (orderId) => call("expire_order", { order_id: orderId }),
    pruneOrders: (orderIds) => call("prune_orders", { order_ids: orderIds }),
    awardCred: (a) => call("award_cred", { player: a.player, xp: a.xp, reason: a.reason }),
  };
}

// ---------- agents signing for themselves (v3) ----------

export interface AgentSigner {
  readonly account: string;
  /** Let the server spend up to `max` of this agent's coins in one haggle. */
  authorizeSpend(haggleId: string, max: number): Promise<string>;
  /** Pay another agent (hire it). */
  payAgent(to: string, amount: number, memo: string): Promise<string>;
  /** Customers only: post a delivery order and lock its bounty. */
  postOrder(a: { orderId: string; goodId: string; bounty: number; deadlineMs: number; site: string; express: boolean }): Promise<string>;
}

export function agentSigner(cfg: { network: Network; contractId: string; account: string; privateKey?: string }): AgentSigner {
  const near = new Near({
    network: cfg.network,
    rpcUrl: RPC[cfg.network],
    defaultSignerId: cfg.account,
    ...(cfg.privateKey
      ? { privateKey: cfg.privateKey as `ed25519:${string}` }
      : { keyStore: new FileKeyStore("~/.near-credentials", cfg.network) }),
  });
  const call = async (method: string, args: object) => {
    const r = await near
      .transaction(cfg.account)
      .functionCall(cfg.contractId, method, args, { gas: "30 Tgas" })
      .send({ waitUntil: "EXECUTED_OPTIMISTIC" });
    return r.transaction.hash as string;
  };
  return {
    account: cfg.account,
    authorizeSpend: (haggleId, max) => call("authorize_spend", { haggle_id: haggleId, max }),
    payAgent: (to, amount, memo) => call("pay_agent", { to, amount, memo }),
    postOrder: (a) =>
      call("post_order", { order_id: a.orderId, good_id: a.goodId, bounty: a.bounty, deadline_ms: a.deadlineMs, site: a.site, express: a.express }),
  };
}

/** Signers for every agent account, keys from AGENT_KEYS or the local keychain. */
export function agentSignersFromEnv(agentIds: string[], env = process.env): Record<string, AgentSigner> | null {
  if (!env.BAZAAR_CONTRACT_ID?.startsWith("v3.")) return null;
  const keys: Record<string, string> = env.AGENT_KEYS ? JSON.parse(env.AGENT_KEYS) : {};
  const network = (env.NEAR_NETWORK as Network) ?? "testnet";
  return Object.fromEntries(
    agentIds.map((id) => {
      const account = `${id}.${env.BAZAAR_CONTRACT_ID}`;
      return [id, agentSigner({ network, contractId: env.BAZAAR_CONTRACT_ID!, account, privateKey: keys[account] })];
    }),
  );
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

export interface AgentView {
  id: string;
  name: string;
  account: string;
  kind: "merchant" | "wholesaler" | "trader" | "runner";
  coins: number;
  /** Units of each requested good, in order. */
  goods: number[];
  /** Average cost per unit of each requested good, in hundredths of a coin. */
  cost_basis: number[];
  daily_cap: number;
  spent_today: number;
}

/** Every agent's purse, stock and policy (v3). */
export async function readAgents(network: Network, contractId: string, goodIds: string[]): Promise<AgentView[]> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<AgentView[]>(contractId, "agents", { good_ids: goodIds }, { finality: "optimistic" })) ?? [];
}

export interface OnchainOrder {
  id: string;
  customer: string;
  good_id: string;
  bounty: number;
  deadline_ms: number;
  site: string;
  express: boolean;
  status: "open" | "delivered" | "expired";
  posted_ms: number;
  courier: string | null;
  fare: number;
}

/** Delivery orders still in contract storage (v3.1). */
export async function readOrders(network: Network, contractId: string, openOnly = false): Promise<OnchainOrder[]> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<OnchainOrder[]>(contractId, "orders", { open_only: openOnly, limit: 100 }, { finality: "optimistic" })) ?? [];
}

export interface OnchainCred {
  xp: number;
  streak: number;
  best_streak: number;
  last_day: number;
}

/** A player's street cred (v3.2). */
export async function readCred(network: Network, contractId: string, player: string): Promise<OnchainCred> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<OnchainCred>(contractId, "cred_of", { player }, { finality: "optimistic" })) ?? { xp: 0, streak: 0, best_streak: 0, last_day: 0 };
}
