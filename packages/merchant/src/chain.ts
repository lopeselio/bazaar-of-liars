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
import type { MerchantSecret, StreetEvent, TipClaim } from "@bazaar/core";
import { archivalRpcUrls, installRpcFailover, primaryRpc, type DeedCertificate, type Network } from "@bazaar/verify";

export type { Network };

// A busy RPC (HTTP 429) falls over to the next public endpoint: see packages/verify/src/rpc.ts.
installRpcFailover();
const RPC: Record<Network, string> = { testnet: primaryRpc("testnet"), mainnet: primaryRpc("mainnet") };
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
  /** v3.3: player stalls. */
  buyLicence?(a: { player: string; slot: string }): Promise<string>;
  stockStall?(a: { player: string; goodId: string; qty: number; price: number }): Promise<string>;
  withdrawStock?(a: { player: string; goodId: string; qty: number }): Promise<string>;
  collectTill?(player: string): Promise<string>;
  stallSale?(a: { saleId: string; slot: string; goodId: string }): Promise<string>;
  /** v3.4: a broke player's dock wage, from the wholesaler's purse (it signs first). */
  payWages?(a: { wageId: string; player: string }): Promise<string>;
  /** v3.6: move a guest's progress to the NEAR account they signed in with. */
  mergePlayer?(a: { from: string; to: string; merchantIds: string[]; goodIds: string[] }): Promise<string>;
  /** v3.7: cargo ship auctions. */
  shipArrives?(auctionId: string): Promise<string>;
  commitBid?(a: { auctionId: string; bidId: string; bidder: string; commitment: string; deposit: number }): Promise<string>;
  revealBid?(a: { auctionId: string; bidder: string; amount: number; salt: string }): Promise<string>;
  settleAuction?(auctionId: string): Promise<string>;
  /** v3.8: the rumour network. */
  sellTip?(a: { tipId: string; informant: string; player: string; commitment: string; price: number; checkMs: number }): Promise<string>;
  resolveTip?(a: { tipId: string; claim: TipClaim; salt: string }): Promise<string>;
  expireTip?(tipId: string): Promise<string>;
  /** v3.9: price boards across the city. */
  buyFromBoard?(a: { player: string; agentId: string; goodId: string; price: number }): Promise<string>;
  sellToBoard?(a: { saleId: string; player: string; goodId: string }): Promise<string>;
  /** Give back an agent's cap for an authorization that was never used. */
  releaseAuth?(authId: string): Promise<string>;
  /** v3.10: street events. */
  startEvent?(eventId: string): Promise<string>;
  inspect?(a: { player: string; goodIds: string[] }): Promise<string>;
  /** v3.11: property deeds (stall licences as NEP-171 NFTs) and the deed market. */
  listDeed?(a: { player: string; price: number }): Promise<string>;
  unlistDeed?(player: string): Promise<string>;
  buyDeed?(a: { buyer: string; slot: string; price: number }): Promise<string>;
  /** v3.12: have NEAR's MPC network sign the deed's ownership for Ethereum (waits for the signature). */
  certifyDeed?(slot: string): Promise<string>;
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
  const call = async (method: string, args: object, waitUntil: "EXECUTED_OPTIMISTIC" | "FINAL" = "EXECUTED_OPTIMISTIC", opts: { gas?: `${number} Tgas`; attachedDeposit?: `${bigint} yocto` } = {}) => {
    const r = await near
      .transaction(cfg.serverId)
      .functionCall(cfg.contractId, method, args, { gas: "30 Tgas", ...opts })
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
    buyLicence: (a) => call("buy_licence", { player: a.player, slot: a.slot }, "FINAL"),
    stockStall: (a) => call("stock_stall", { player: a.player, good_id: a.goodId, qty: a.qty, price: a.price }, "FINAL"),
    withdrawStock: (a) => call("withdraw_stock", { player: a.player, good_id: a.goodId, qty: a.qty }, "FINAL"),
    collectTill: (player) => call("collect_till", { player }, "FINAL"),
    stallSale: (a) => call("stall_sale", { sale_id: a.saleId, slot: a.slot, good_id: a.goodId }),
    payWages: (a) => call("pay_wages", { wage_id: a.wageId, player: a.player }, "FINAL"),
    mergePlayer: (a) => call("merge_player", { from: a.from, to: a.to, merchant_ids: a.merchantIds, good_ids: a.goodIds }, "FINAL"),
    shipArrives: (auctionId) => call("ship_arrives", { auction_id: auctionId }, "FINAL"),
    commitBid: (a) => call("commit_bid", { auction_id: a.auctionId, bid_id: a.bidId, bidder: a.bidder, commitment: a.commitment, deposit: a.deposit }, "FINAL"),
    revealBid: (a) => call("reveal_bid", { auction_id: a.auctionId, bidder: a.bidder, amount: a.amount, salt: a.salt }, "FINAL"),
    settleAuction: (auctionId) => call("settle_auction", { auction_id: auctionId }, "FINAL"),
    sellTip: (a) => call("sell_tip", { tip_id: a.tipId, informant: a.informant, player: a.player, commitment: a.commitment, price: a.price, check_ms: a.checkMs }, "FINAL"),
    resolveTip: (a) => call("resolve_tip", { tip_id: a.tipId, claim: a.claim, salt: a.salt }, "FINAL"),
    expireTip: (tipId) => call("expire_tip", { tip_id: tipId }, "FINAL"),
    buyFromBoard: (a) => call("buy_from_board", { player: a.player, agent_id: a.agentId, good_id: a.goodId, price: a.price }, "FINAL"),
    sellToBoard: (a) => call("sell_to_board", { sale_id: a.saleId, player: a.player, good_id: a.goodId }, "FINAL"),
    releaseAuth: (authId) => call("release_auth", { auth_id: authId }),
    startEvent: (eventId) => call("start_event", { event_id: eventId }, "FINAL"),
    inspect: (a) => call("inspect", { player: a.player, good_ids: a.goodIds }, "FINAL"),
    listDeed: (a) => call("list_deed", { player: a.player, price: a.price }, "FINAL"),
    unlistDeed: (player) => call("unlist_deed", { player }, "FINAL"),
    buyDeed: (a) => call("buy_deed", { buyer: a.buyer, slot: a.slot, price: a.price }, "FINAL"),
    // The MPC network answers a few blocks later; FINAL waits for its callback too.
    certifyDeed: (slot) => call("certify_deed", { slot }, "FINAL", { gas: "100 Tgas", attachedDeposit: "1 yocto" }),
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

/**
 * Agents moved to a fresh account by `rekey_agent` (their old key ran out of gas allowance):
 * AGENT_ACCOUNTS is a JSON map of agent id → account. Others use `<id>.<contract>`.
 */
export function agentAccounts(env = process.env): Record<string, string> {
  if (!env.AGENT_ACCOUNTS) return {};
  const m = JSON.parse(env.AGENT_ACCOUNTS) as Record<string, string>;
  for (const [id, acct] of Object.entries(m)) if (!acct.endsWith(`.${env.BAZAAR_CONTRACT_ID}`)) throw new Error(`AGENT_ACCOUNTS: ${id} → ${acct} is not a sub-account of the contract`);
  return m;
}

/** Each agent's current account as the contract records it (it changes when an agent is rekeyed). */
export async function readAgentAccounts(network: Network, contractId: string): Promise<Record<string, string>> {
  const agents = await readAgents(network, contractId, []);
  return Object.fromEntries(agents.map((a) => [a.id, a.account]));
}

/** Signers for every agent account, keys from AGENT_KEYS or the local keychain. */
export function agentSignersFromEnv(agentIds: string[], env = process.env, onchain: Record<string, string> = {}): Record<string, AgentSigner> | null {
  if (!env.BAZAAR_CONTRACT_ID?.startsWith("v3.")) return null;
  const keys: Record<string, string> = env.AGENT_KEYS ? JSON.parse(env.AGENT_KEYS) : {};
  // The contract is the source of truth for each agent's account; AGENT_ACCOUNTS is the fallback
  // for when it can't be read at startup.
  const accounts = { ...agentAccounts(env), ...onchain };
  const network = (env.NEAR_NETWORK as Network) ?? "testnet";
  return Object.fromEntries(
    agentIds.map((id) => {
      const account = accounts[id] ?? `${id}.${env.BAZAAR_CONTRACT_ID}`;
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
  const j = (await res.json().catch(() => ({}))) as { result?: T; error?: { message?: string; cause?: { name?: string } } };
  if (!j.result) throw Object.assign(new Error(`${method}: ${j.error?.cause?.name ?? j.error?.message ?? res.status}`), { cause: j.error?.cause?.name });
  return j.result;
}

/** A keyless read: the regular RPC first, then archival nodes for history it has pruned. */
async function rpc<T>(network: Network, method: string, params: unknown): Promise<T> {
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
    const v = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export const nearReader: ChainReader = {
  async getHaggle(network, contractId, haggleId) {
    const near = new Near({ network, rpcUrl: RPC[network] });
    return (await near.view<OnchainHaggle | null>(contractId, "get_haggle", { haggle_id: haggleId })) ?? null;
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

export interface OnchainStall {
  slot: string;
  owner: string;
  listings: { good_id: string; qty: number; price: number }[];
  till: number;
  sold: number;
  earned: number;
  opened_ms: number;
}

/** Every licensed player stall (v3.3). */
export async function readStalls(network: Network, contractId: string): Promise<OnchainStall[]> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<OnchainStall[]>(contractId, "stalls", {}, { finality: "optimistic" })) ?? [];
}

export interface OnchainBid {
  bidder: string;
  commitment: string;
  deposit: number;
  agent: boolean;
  committed_ms: number;
  amount: number | null;
}

export interface OnchainAuction {
  id: string;
  good_id: string;
  qty: number;
  reserve: number;
  opened_ms: number;
  bids_close_ms: number;
  reveal_close_ms: number;
  status: "bidding" | "settled" | "unsold";
  bids: OnchainBid[];
  winner: string | null;
  price: number;
}

/** Recent cargo ship auctions, newest first (v3.7). */
export async function readAuctions(network: Network, contractId: string): Promise<OnchainAuction[]> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<OnchainAuction[]>(contractId, "auctions", {}, { finality: "optimistic" })) ?? [];
}

export interface OnchainTip {
  id: string;
  informant: string;
  player: string;
  commitment: string;
  price: number;
  sold_ms: number;
  check_ms: number;
  status: "pending" | "true" | "false" | "hidden" | "void";
  claim: TipClaim | null;
  observed: number | null;
}

export interface InformantRecord {
  id: string;
  sold: number;
  truths: number;
  lies: number;
  hidden: number;
}

/** A player's recent tips, newest first (v3.8). */
export async function readTips(network: Network, contractId: string, player: string): Promise<OnchainTip[]> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<OnchainTip[]>(contractId, "tips_of", { player }, { finality: "optimistic" })) ?? [];
}

/** Informants' public records of truths and lies (v3.8). */
export async function readInformants(network: Network, contractId: string, ids: string[]): Promise<InformantRecord[]> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<InformantRecord[]>(contractId, "informants", { ids }, { finality: "optimistic" })) ?? [];
}

/** One tip, as the contract recorded it (v3.8). */
export async function readTip(network: Network, contractId: string, tipId: string): Promise<OnchainTip | null> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<OnchainTip | null>(contractId, "get_tip", { tip_id: tipId }, { finality: "optimistic" })) ?? null;
}

/** The current or most recent street event (v3.10). */
export async function readEvent(network: Network, contractId: string): Promise<StreetEvent | null> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<StreetEvent | null>(contractId, "street_event", {}, { finality: "optimistic" })) ?? null;
}

export interface DeedAsk {
  slot: string;
  owner: string;
  price: number;
}

/** Deeds on the market (v3.11). */
export async function readDeedAsks(network: Network, contractId: string): Promise<DeedAsk[]> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<DeedAsk[]>(contractId, "deed_asks", {}, { finality: "optimistic" })) ?? [];
}

/** A deed's latest Ethereum certificate (v3.12). It may name a previous owner. */
export async function readDeedCertificate(network: Network, contractId: string, slot: string): Promise<DeedCertificate | null> {
  const near = new Near({ network, rpcUrl: RPC[network] });
  return (await near.view<DeedCertificate | null>(contractId, "deed_certificate", { slot }, { finality: "optimistic" })) ?? null;
}

// ---------- gas and funding (the economy watchdog) ----------

const YOCTO = 1e24;

/** NEAR an account holds and, for a function-call key, what's left of its gas allowance. */
export async function readAccountGas(network: Network, account: string): Promise<{ balance: number; allowance: number | null }> {
  const acct = await rpc<{ amount: string }>(network, "query", { request_type: "view_account", finality: "final", account_id: account });
  const keys = await rpc<{ keys: { access_key: { permission: "FullAccess" | { FunctionCall: { allowance: string | null } } } }[] }>(network, "query", {
    request_type: "view_access_key_list",
    finality: "final",
    account_id: account,
  });
  // An agent has exactly one key; take the smallest allowance among function-call keys.
  const allowances = keys.keys
    .map((k) => k.access_key.permission)
    .filter((p): p is { FunctionCall: { allowance: string | null } } => typeof p === "object" && p.FunctionCall?.allowance != null)
    .map((p) => Number(p.FunctionCall.allowance) / YOCTO);
  return { balance: Number(acct.amount) / YOCTO, allowance: allowances.length ? Math.min(...allowances) : null };
}

/** Send NEAR from an account whose key we hold (the watchdog's funder). Returns the tx hash. */
export async function sendNear(cfg: { network: Network; from: string; privateKey?: string }, to: string, amountNear: number): Promise<string> {
  const near = new Near({
    network: cfg.network,
    rpcUrl: RPC[cfg.network],
    defaultSignerId: cfg.from,
    ...(cfg.privateKey ? { privateKey: cfg.privateKey as `ed25519:${string}` } : { keyStore: new FileKeyStore("~/.near-credentials", cfg.network) }),
  });
  const r = await near.transaction(cfg.from).transfer(to, `${amountNear} NEAR`).send({ waitUntil: "FINAL" });
  return r.transaction.hash as string;
}
