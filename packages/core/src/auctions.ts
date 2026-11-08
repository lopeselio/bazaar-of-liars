/**
 * Cargo ship auctions at Pier 34.
 *
 * Every few minutes a ship docks with a lot the contract rolls itself (which good, how many, the
 * reserve). Bidding is sealed: a bidder posts sha256 of its bid plus a deposit, and only reveals
 * the amount once bidding has closed. A player's bid is hashed in their own browser and the salt
 * stays there, so not even the game server sees it before the reveal. Agents bid too, each from
 * its own purse, each deposit signed by the agent itself.
 *
 * Highest revealed bid at or above the reserve wins and pays its bid (first price). A bid that's
 * never revealed gets its deposit back less 10%.
 *
 * Constants MUST match contracts/bazaar.
 */
import { sha256Hex } from "./hash.js";
import type { Rng } from "./rng.js";

export const SHIP_GAP_MS = 8 * 60_000;
export const BID_WINDOW_MS = 150_000;
export const REVEAL_WINDOW_MS = 75_000;
export const UNREVEALED_PENALTY_PCT = 10;
export const XP_AUCTION_WIN = 10;
/** How close to the pier a player must be to bid (metres). */
export const PIER_REACH = 60;

/** sha256("bazaar-bid|auction|bidder|amount|salt"). Byte-identical to the contract. */
export function bidCommitment(auctionId: string, bidder: string, amount: number, salt: string): string {
  return sha256Hex(`bazaar-bid|${auctionId}|${bidder}|${amount}|${salt}`);
}

/**
 * A deposit that covers the bid without giving it away: the next round 50 above it, but never
 * more than the bidder holds, and at least the reserve.
 */
export function depositFor(amount: number, reserve: number, coins: number): number {
  const round = Math.ceil((amount + 1) / 50) * 50;
  return Math.max(reserve, amount, Math.min(coins, round));
}

/** Per-unit value each kind of agent puts on a lot, as a share of the good's street value. */
const VALUE_SHARE: Record<string, number> = { wholesaler: 0.6, merchant: 0.78, trader: 0.66 };
/** Wu sits out a lot once she already holds this many of that good: she can't resell faster, and
 * every winning bid is burned, so hoarding drains coins out of the street. */
export const WHOLESALER_STOCK_CAP = 40;

/**
 * What an agent bids on a lot, or null if it sits this one out. Wu bids on everything she isn't
 * already overstocked on (she resells lots to merchants), a merchant bids on its own good when its shelf is low, and traders
 * bid when they have room in their purse. Never more than the agent can spend today.
 */
export function agentBid(
  a: { kind: string; sells?: string; stock: number; coins: number; capLeft: number },
  lot: { goodId: string; qty: number; reserve: number; baseValue: number },
  rng: Rng,
): number | null {
  const share = VALUE_SHARE[a.kind];
  if (share === undefined) return null;
  if (a.kind === "merchant" && (a.sells !== lot.goodId || a.stock > 3)) return null;
  if (a.kind === "wholesaler" && a.stock > WHOLESALER_STOCK_CAP) return null;
  if (a.kind === "trader" && rng() < 0.5) return null;
  const value = Math.round(lot.baseValue * lot.qty * share * (0.9 + 0.15 * rng()));
  // Keep headroom under the purse and cap, so the deposit can round up past the bid instead of
  // equalling it (a deposit equal to the bid would give the bid away).
  const budget = Math.floor(Math.min(a.coins, a.capLeft) * 0.85);
  const bid = Math.min(value, budget);
  return bid >= lot.reserve ? bid : null;
}
