/**
 * The way back from broke for agents: Auntie Wu's advances.
 *
 * Coins reach merchants only through sales, and a merchant with no stock can't sell, so a broke
 * merchant stays broke until a player invests. On a quiet testnet that can take days, and a
 * shuttered Canal Street is no demo. So the wholesaler, who holds most of the street's coins
 * (she's paid for every lot), advances a broke merchant enough for one lot, and a broke rival
 * trader enough to buy one good to flip. Nothing is minted: the coins move from her purse with
 * `pay_agent`, signed by her own key and counted against her onchain daily cap. When the
 * borrower can afford it again, it repays her the same way, signed by its own key.
 *
 * Pure rules, tested without a chain. The watchdog decides who is broke for too long; the market
 * signs the payments.
 */
import { GOODS } from "./catalog.js";
import { DAILY_CAP, LOT_SIZE, WHOLESALE_BID_MAX, runnerFee } from "./economy.js";
import { DOCK_WAGE } from "./wages.js";

/** Broke for this long, the watchdog asks Wu to step in. */
export const RELIEF_AFTER_MS = 2 * 3_600_000;
/** Wu keeps this much for dock wages and her own auction bids. */
export const WU_RESERVE = 200;
/** …and room under her daily cap for this many dock shifts. */
export const WAGE_ROOM = 2 * DOCK_WAGE;
/** A trader's advance: enough to buy one good to flip. */
export const TRADER_ADVANCE = 80;

export interface Borrower {
  id: string;
  kind: string;
  coins: number;
  /** For a merchant: the good it sells (it restocks that). */
  goodId?: string;
  /** Coins it already owes Wu. */
  owed: number;
}

/** What a borrower needs to trade again: one lot plus the runner for a merchant, one good for a trader. */
export function tradingFloat(b: Pick<Borrower, "kind" | "goodId">): number {
  if (b.kind === "merchant" && b.goodId && GOODS[b.goodId]) return Math.ceil(GOODS[b.goodId].baseValue * WHOLESALE_BID_MAX * LOT_SIZE) + runnerFee(LOT_SIZE);
  if (b.kind === "trader") return TRADER_ADVANCE;
  return 0;
}

/**
 * How much Wu advances, or null with the reason she doesn't: one loan at a time per borrower,
 * never past her reserve or the room she keeps under her cap for wages.
 */
export function advanceFor(b: Borrower, wu: { coins: number; spentToday: number; dailyCap?: number }): { amount: number } | { skip: string } {
  if (b.kind !== "merchant" && b.kind !== "trader") return { skip: "only merchants and traders get advances" };
  if (b.owed > 0) return { skip: `already owes Auntie Wu ${b.owed}` };
  const amount = tradingFloat(b) - b.coins;
  if (amount <= 0) return { skip: "can already afford to trade" };
  const capLeft = (wu.dailyCap ?? DAILY_CAP.wholesaler) - wu.spentToday;
  if (wu.coins - amount < WU_RESERVE) return { skip: `Auntie Wu is keeping her last ${WU_RESERVE} coins` };
  if (capLeft - amount < WAGE_ROOM) return { skip: "Auntie Wu has spent her daily cap" };
  return { amount };
}

/** A borrower repays in full once it holds the loan plus what it needs to keep trading. */
export function repaymentFor(b: Borrower & { spentToday: number; dailyCap: number }): number | null {
  if (b.owed <= 0) return null;
  if (b.coins < b.owed + tradingFloat(b)) return null;
  if (b.dailyCap - b.spentToday < b.owed) return null;
  return b.owed;
}
