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

/** Street cred, kept onchain by the bazaar contract. */
export interface Cred {
  xp: number;
  level: number;
  title: string;
  levelXp: number;
  nextXp: number;
  streak: number;
  bestStreak: number;
  activeToday: boolean;
}

export interface PlayerView {
  id: string;
  known: boolean;
  coins: number;
  goods: Record<string, number>;
  /** Coins plus goods at their base value. */
  worth: number;
  day: Day;
  cred: Cred | null;
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

/** A NEAR Auth session: the player's NEAR account and the server's token for it. */
export interface Session {
  account: string;
  publicKey: string;
  token: string;
  exp: number;
}
const SESSION_KEY = "bazaar.session";
export function loadSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Session | null;
    return s && s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}
export function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode: the session lasts this page only */
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const session = loadSession();
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
    },
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
  kind: "sale" | "restock" | "hire" | "trade" | "consume" | "invest" | "closed" | "order" | "delivery" | "stall" | "auction" | "rumour" | "route";
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
  /** Street cred level needed to take it, or null if this player can. */
  needsLevel: number | null;
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

export interface Listing {
  good_id: string;
  qty: number;
  price: number;
}
/** A player-owned stall on Canal Street, settled by the contract. */
export interface OwnStall {
  slot: string;
  owner: string;
  listings: Listing[];
  till: number;
  sold: number;
  earned: number;
  opened_ms: number;
}
export interface StallsView {
  slots: { slot: string; owner: string | null; mine: boolean; listings: Listing[]; sold: number }[];
  mine: OwnStall | null;
  /** What the player's stall did since their last visit. */
  away?: { sold: number; earned: number } | null;
  licencePrice: number;
  licenceLevel: number;
}
type StallResult = { ok: true; txUrl: string; stalls: StallsView; player: PlayerView };

export interface AuctionLot {
  id: string;
  goodId: string;
  goodName: string;
  qty: number;
  reserve: number;
  opened: number;
  bidsClose: number;
  revealClose: number;
  status: "bidding" | "settled" | "unsold";
  /** `deposit` is null for others' bids while bidding is open. */
  bids: { who: string; mine: boolean; agent: boolean; deposit: number | null; amount: number | null }[];
  winner: string | null;
  youWon: boolean;
  price: number;
}
export interface AuctionsView {
  lot: AuctionLot | null;
  recent: AuctionLot[];
  nextShip?: number;
  windows: { bidMs: number; revealMs: number; gapMs: number };
  pier: { x: number; z: number };
}
export interface InformantView {
  id: string;
  name: string;
  where: string;
  x: number;
  z: number;
  price: number;
  sold: number;
  truths: number;
  lies: number;
  hidden: number;
}
export interface TipView {
  id: string;
  informant: string;
  price: number;
  checkMs: number;
  status: "pending" | "true" | "false" | "hidden" | "void";
  /** What the informant whispered: only for the buyer. */
  text: string | null;
  plain: string | null;
  observed: number | null;
  commitment: string;
}
export interface RumoursView {
  informants: InformantView[];
  tips: TipView[];
  reach: number;
}
type AuctionResult = { ok: true; txUrl: string; auctions: AuctionsView | null; player: PlayerView | null };

export const api = {
  /** `origins`: where NEAR Auth's Auth0 client allows sign-in to return to. */
  authConfig: () => call<{ domain: string; clientId: string; origins: string[] }>("/api/auth/config"),
  startSession: (idToken: string) => call<Session & { player: PlayerView }>("/api/auth/session", { idToken }),
  linkGuest: (guest: string) => call<{ ok: true; player: PlayerView }>("/api/auth/link", { guest }),
  merchants: () => call<{ merchants: MerchantInfo[]; model: string; onchain: { network: string; contractId: string } | null }>("/api/merchants"),
  player: (id: string) => call<PlayerView>(`/api/player?id=${encodeURIComponent(id)}`),
  open: (merchantId: string, player: string, side: Side) => call<Opened>("/api/haggle", { merchantId, player, side }),
  leaderboard: () => call<{ leaders: { player: string; peak: number }[] }>("/api/leaderboard"),
  turn: (haggleId: string, text: string) => call<TurnOut>(`/api/haggle/${haggleId}/turn`, { text }),
  nextDay: (player: string) => call<PlayerView>("/api/day/next", { player }),
  market: () => call<{ agents: MarketAgent[]; news: NewsItem[]; onchain: boolean; contractId?: string }>("/api/market"),
  orders: (player: string) => call<{ orders: Order[]; job: Job | null; now: number; level: number }>(`/api/orders?player=${encodeURIComponent(player)}`),
  takeOrder: (id: string, player: string, x: number, z: number) => call<{ job: Job; order: Order }>(`/api/orders/${id}/take`, { player, x, z }),
  deliver: (id: string, player: string, x: number, z: number, mode: TravelMode) =>
    call<Delivered>(`/api/orders/${id}/deliver`, { player, x, z, mode }),
  stalls: (player: string, visit = false) => call<StallsView>(`/api/stalls?player=${encodeURIComponent(player)}${visit ? "&visit=1" : ""}`),
  buyLicence: (player: string, slot: string) => call<StallResult>("/api/stalls/licence", { player, slot }),
  stockStall: (player: string, goodId: string, qty: number, price: number) => call<StallResult>("/api/stalls/stock", { player, goodId, qty, price }),
  withdrawStock: (player: string, goodId: string, qty: number) => call<StallResult>("/api/stalls/withdraw", { player, goodId, qty }),
  collectTill: (player: string) => call<StallResult>("/api/stalls/collect", { player }),
  dockWork: (player: string, x: number, z: number) => call<{ wage: number; txUrl: string; player: PlayerView }>("/api/dockwork", { player, x, z }),
  auctions: (player: string) => call<AuctionsView>(`/api/auctions?player=${encodeURIComponent(player)}`),
  bid: (id: string, player: string, commitment: string, deposit: number, x: number, z: number) =>
    call<AuctionResult>(`/api/auctions/${id}/bid`, { player, commitment, deposit, x, z }),
  reveal: (id: string, player: string, amount: number, salt: string) => call<AuctionResult>(`/api/auctions/${id}/reveal`, { player, amount, salt }),
  rumours: (player: string) => call<RumoursView>(`/api/rumours?player=${encodeURIComponent(player)}`),
  buyTip: (informant: string, player: string, x: number, z: number) =>
    call<{ tip: { id: string; informant: string; text: string; plain: string; checkMs: number; price: number }; txUrl: string; player: PlayerView | null }>(`/api/rumours/${informant}/buy`, { player, x, z }),
  invest: (player: string, agentId: string, amount: number) => call<{ ok: true; txUrl: string; player: PlayerView }>("/api/invest", { player, agentId, amount }),
};
