/** Typed client for apps/server. */
export interface Good {
  id: string;
  name: string;
  baseValue: number;
}
export interface MerchantInfo {
  id: string;
  name: string;
  good: Good;
  buys: Good;
}
export type Side = "sell" | "buy";
export interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}
export type Tell = "relaxed" | "firm" | "nervous" | "irritated";
export type Action = "counter" | "final" | "accept" | "walk" | "left" | null;

/** A market day, kept by the server: a fixed number of haggles, then sundown. */
export interface Day {
  n: number;
  left: number;
  perDay: number;
  /** Purse + goods at the start of the day. */
  startWorth: number;
}

export interface PlayerView {
  id: string;
  known: boolean;
  coins: number;
  goods: Record<string, number>;
  /** Coins plus goods at their base value. */
  worth: number;
  day: Day;
  onchain: boolean;
  network?: string;
  contractId?: string;
}

export interface Opened {
  haggleId: string;
  merchant: { id: string; name: string };
  side: Side;
  good: Good;
  memory: { lowballs: number; deals: number; grudge: number; loyalty: number };
  commitment: string;
  openingAsk: number;
  budget: number;
  day: Day;
  /** Why the merchant prices the way it does today (agent economy only). */
  reasons?: string[];
  openTx: string | null;
  openTxUrl: string | null;
  attestation: { model: string; nonce: string; verifiedAt: string; signers: string[]; checks: Check[] };
  ms: number;
}

export interface Ending {
  status: "deal" | "walked" | "left" | "open";
  side: Side;
  dealPrice: number | null;
  leftOnTable: number | null;
  secret: { floor: number; need: string; listPrice: number; grudge: number; loyalty: number };
  claims: { turn: number; claimed: number; truth: boolean; said: string; called?: "caught" | "honest" }[];
  calls: { turn: number; result: "caught" | "honest" }[];
  tells: { turn: number; tell: Tell; gap: number }[];
  chain: {
    contractId: string;
    network: string;
    openTx: string;
    openTxUrl: string;
    closeTx: string | null;
    closeTxUrl: string | null;
    closeError: string | null;
  } | null;
  checks: Check[];
  /** The day after this haggle was counted. */
  day: Day | null;
  bundle: unknown;
}

export interface TurnOut {
  text: string;
  action: Action;
  price: number | null;
  tell: Tell | null;
  status: string;
  ask: number | null;
  refused: { reason: "budget"; budget: number; price: number } | null;
  claim: number | null;
  call: "caught" | "honest" | null;
  ms: number;
  end?: Ending;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j as T;
}

/** One of Canal Street's agents, read from the contract. */
export interface MarketAgent {
  id: string;
  name: string;
  kind: "merchant" | "wholesaler" | "trader" | "runner";
  account: string;
  accountUrl: string;
  coins: number;
  stock: Record<string, number>;
  costBasis: Record<string, number>;
  dailyCap: number;
  spentToday: number;
  status?: "open" | "sold_out" | "broke";
}
export interface NewsItem {
  t: number;
  kind: "sale" | "restock" | "hire" | "trade" | "consume" | "invest" | "closed";
  text: string;
  tx?: string;
  agents: string[];
}

/** A customer's delivery order, posted onchain with its bounty locked. */
export interface Order {
  id: string;
  customer: string;
  customerName: string;
  good_id: string;
  goodName: string;
  bounty: number;
  deadline_ms: number;
  site: string;
  siteName: string;
  district: string;
  x: number;
  z: number;
  express: boolean;
}
export interface Job {
  orderId: string;
  takenAt: number;
  from: { x: number; z: number };
}
export type TravelMode = "foot" | "bike" | "cab" | "heli";
export interface Delivered {
  bounty: number;
  fare: number;
  net: number;
  mode: TravelMode;
  metres: number;
  seconds: number;
  msToSpare: number;
  txUrl: string;
  player: PlayerView;
}

export const api = {
  merchants: () => call<{ merchants: MerchantInfo[]; model: string; onchain: { network: string; contractId: string } | null }>("/api/merchants"),
  player: (id: string) => call<PlayerView>(`/api/player?id=${encodeURIComponent(id)}`),
  open: (merchantId: string, player: string, side: Side) => call<Opened>("/api/haggle", { merchantId, player, side }),
  leaderboard: () => call<{ leaders: { player: string; peak: number }[] }>("/api/leaderboard"),
  turn: (haggleId: string, text: string) => call<TurnOut>(`/api/haggle/${haggleId}/turn`, { text }),
  nextDay: (player: string) => call<PlayerView>("/api/day/next", { player }),
  market: () => call<{ agents: MarketAgent[]; news: NewsItem[]; onchain: boolean; contractId?: string }>("/api/market"),
  orders: (player: string) => call<{ orders: Order[]; job: Job | null; now: number }>(`/api/orders?player=${encodeURIComponent(player)}`),
  takeOrder: (id: string, player: string, x: number, z: number) => call<{ job: Job; order: Order }>(`/api/orders/${id}/take`, { player, x, z }),
  deliver: (id: string, player: string, x: number, z: number, mode: TravelMode) =>
    call<Delivered>(`/api/orders/${id}/deliver`, { player, x, z, mode }),
  invest: (player: string, agentId: string, amount: number) => call<{ ok: true; txUrl: string; player: PlayerView }>("/api/invest", { player, agentId, amount }),
};
