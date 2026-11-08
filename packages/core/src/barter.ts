/**
 * Barter settled through NEAR Intents. A merchant that has run out of the good it uses (its
 * `buysGoodId`) can trade some of its own stock with Auntie Wu instead of finding coins: each side
 * signs a token_diff intent and the Verifier settles both or neither. Wu prices it like a market
 * maker, taking an edge, and keeps a reserve. Pure, so it's tested without a chain.
 */
import type { Rng } from "./rng.js";

/** Chance per market tick that one eligible merchant barters (each barter costs the server ~0.004 NEAR of gas). */
export const BARTER_CHANCE = 0.012;
/** Wu's edge: she credits 85% of the street value of what she receives. */
export const WU_BARTER_SHARE = 0.85;
/** A merchant keeps at least this many of its own good on the shelf after a barter. */
export const BARTER_SHELF_KEEP = 1;
/** Wu won't barter away her last units of a good. */
export const WU_BARTER_RESERVE = 20;

export interface BarterQuote {
  give: { good: string; qty: number };
  get: { good: string; qty: number };
}

/**
 * What a merchant would give Wu, and get back, to restock the good it uses, or null if it shouldn't
 * barter now. It gives the fewest units of its own good that buy one unit of what it needs at Wu's
 * price (Wu credits 85% of value), and gets as many units as that pays for.
 */
export function barterQuote(
  m: { sells: string; uses: string },
  have: { sells: number; uses: number },
  wuHas: number,
  values: Record<string, number>,
): BarterQuote | null {
  if (have.uses > 0) return null; // still has some to use
  const sell = values[m.sells], use = values[m.uses];
  if (!sell || !use || m.sells === m.uses) return null;
  const credit = sell * WU_BARTER_SHARE;
  const give = Math.ceil(use / credit);
  if (have.sells - give < BARTER_SHELF_KEEP) return null; // would empty the shelf
  const get = Math.floor((give * credit) / use);
  if (get < 1 || wuHas - get < WU_BARTER_RESERVE) return null;
  return { give: { good: m.sells, qty: give }, get: { good: m.uses, qty: get } };
}

/** Pick one merchant to barter this tick, or none. */
export function pickBarter<T>(candidates: T[], rng: Rng): T | null {
  if (!candidates.length || rng() >= BARTER_CHANCE) return null;
  return candidates[Math.floor(rng() * candidates.length)] ?? null;
}
