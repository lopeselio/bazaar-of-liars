/**
 * Player-owned stalls on Canal Street: the reason to come back.
 *
 * At street cred level 3 a player can buy a licence for one of a few stall slots. They stock it
 * with goods they own and set their own prices. While they're away, agents buy from it: rival
 * traders looking for something to flip, and customers whose delivery nobody brought. Each
 * purchase is signed by the buying agent, settled by the contract, and lands in the stall's till,
 * less a street commission. The player collects the till when they return.
 *
 * Constants MUST match contracts/bazaar.
 */
import type { Rng } from "./rng.js";

/** Licensable stall slots, further along Canal Street than the merchants. */
export const STALL_SLOTS = ["corner-1", "corner-2", "corner-3", "corner-4"] as const;
export type StallSlot = (typeof STALL_SLOTS)[number];
/** Coins a licence costs (burned: the street's licence fee). */
export const LICENCE_PRICE = 150;
/** Street cred level needed for a licence (XP 120). */
export const LICENCE_LEVEL = 3;
/** Share of every stall sale the street keeps, in percent (burned). */
export const STALL_COMMISSION_PCT = 10;
/** Highest price a player may list. */
export const MAX_STALL_PRICE = 500;

/** What the stall owner keeps from a sale. */
export const ownerTake = (price: number) => price - Math.floor((price * STALL_COMMISSION_PCT) / 100);

/**
 * Would a rival trader buy this listing? A trader buys when it can resell for more: the price
 * must sit under what a buying merchant usually pays (about street value). Cheaper listings sell
 * more often; at or above street value they rarely do.
 */
export function traderWouldBuy(price: number, baseValue: number, coins: number, rng: Rng): boolean {
  if (price > coins || price > baseValue * 1.1) return false;
  const discount = 1 - price / baseValue; // 0.3 = 30% under street value
  const chance = Math.min(0.9, Math.max(0.08, 0.25 + discount * 2));
  return rng() < chance;
}

/**
 * Would a customer, about to give up on a delivery, buy from a stall instead? Only when the
 * listing is within its bounty, so the customer pays no more than it budgeted.
 */
export const customerWouldBuy = (price: number, bounty: number) => price <= bounty;
