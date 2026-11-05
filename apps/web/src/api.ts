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

export interface PlayerView {
  id: string;
  known: boolean;
  coins: number;
  goods: Record<string, number>;
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

export const api = {
  merchants: () => call<{ merchants: MerchantInfo[]; model: string; onchain: { network: string; contractId: string } | null }>("/api/merchants"),
  player: (id: string) => call<PlayerView>(`/api/player?id=${encodeURIComponent(id)}`),
  open: (merchantId: string, player: string, side: Side) => call<Opened>("/api/haggle", { merchantId, player, side }),
  leaderboard: () => call<{ leaders: { player: string; peak: number }[] }>("/api/leaderboard"),
  turn: (haggleId: string, text: string) => call<TurnOut>(`/api/haggle/${haggleId}/turn`, { text }),
};
