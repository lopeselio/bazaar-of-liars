/**
 * Canal Street's economy: every pricing and spending rule the agents follow, in one file.
 *
 * Merchants are agents with their own NEAR accounts. They hold coins and stock onchain, sell to
 * players, buy what they want from players, restock in lots from the wholesaler at the docks, and
 * pay a runner to haul each lot. Rival traders buy low at one stall and sell high at another.
 * Each rule returns its reasons, so the game can show why a price is what it is.
 *
 * These functions decide the hidden numbers that get committed onchain. The rules engine
 * (rules.ts) still makes every haggle decision, and the contract enforces the hard limits:
 * a merchant never sells below what its stock cost it, and no agent spends past its daily cap.
 */
import { pickWeighted, type Rng } from "./rng.js";
import type { Good, Merchant, MerchantSecret, Need, PlayerMemory } from "./types.js";

/** What an agent holds, as read from the contract. */
export interface Holdings {
  coins: number;
  /** Units of the good in question. */
  stock: number;
  /** Average price paid per unit of that good (0 if never bought). */
  costBasis: number;
}

export interface Reason {
  label: string;
  /** Multiplier applied, or an absolute bound. */
  effect: string;
}

export interface Priced {
  secret: MerchantSecret;
  reasons: Reason[];
}

// ---------- tunables ----------

/** Units in one wholesale lot. */
export const LOT_SIZE = 4;
/** A merchant restocks when its shelf drops to this many units. */
export const RESTOCK_AT = 1;
/** A merchant buying from a player never commits more than this share of its purse to one haggle. */
export const MAX_PURSE_SHARE = 0.6;
/** Coins a runner charges per haul: a base fee plus a little per unit. */
export const runnerFee = (qty: number) => 3 + qty;
/** Most a merchant will pay per unit at wholesale, as a share of the street value. */
export const WHOLESALE_BID_MAX = 0.7;
/** Daily spending cap written into each agent's onchain policy. */
export const DAILY_CAP: Record<string, number> = { merchant: 400, trader: 600, wholesaler: 0, runner: 50, customer: 500, cab: 0 };
/** Most coins a customer's business brings in per day: the money that funds its bounties. */
export const CUSTOMER_INCOME_PER_DAY = 400;

const memoryLevels = (m: PlayerMemory = { lowballs: 0, deals: 0 }) => ({
  grudge: Math.min(5, Math.max(0, m.lowballs)),
  loyalty: Math.min(5, Math.max(0, m.deals)),
});
const pct = (k: number) => `${k >= 1 ? "+" : "−"}${Math.round(Math.abs(k - 1) * 100)}%`;

// ---------- merchant selling to a player ----------

/** How eager a merchant is, from its purse and shelf. */
export function sellerNeed(h: Holdings, rng: Rng): Need {
  if (h.coins < 25) return "rent_due"; // broke: needs the sale
  if (h.stock <= 1) return "hoarding"; // last piece: reluctant
  if (h.stock >= 6) return "restocking"; // overstocked: wants turnover
  return pickWeighted(rng, [
    ["comfortable", 3],
    ["restocking", 1],
  ]);
}

/**
 * The floor a merchant commits to when selling one unit.
 * Street value, nudged by scarcity (few left → dearer), demand (recent sales → dearer) and a
 * little noise, but never below what the unit cost it.
 */
export function sellFloor(good: Good, h: Holdings, recentSales: number, rng: Rng) {
  const reasons: Reason[] = [{ label: `Street value of ${good.name}`, effect: String(good.baseValue) }];
  const scarcity = h.stock <= 2 ? 1 + 0.12 * (3 - h.stock) : h.stock >= 6 ? 1 - 0.04 * Math.min(5, h.stock - 5) : 1;
  if (scarcity !== 1) reasons.push({ label: h.stock <= 2 ? `Only ${h.stock} left` : `${h.stock} on the shelf`, effect: pct(scarcity) });
  const demand = 1 + 0.05 * Math.min(6, recentSales);
  if (recentSales > 0) reasons.push({ label: `${recentSales} sold recently`, effect: pct(demand) });
  const noise = 0.85 + 0.15 * rng();
  let floor = Math.round(good.baseValue * scarcity * demand * noise);
  const minFloor = Math.ceil(h.costBasis) + 1;
  if (floor < minFloor) {
    floor = minFloor;
    reasons.push({ label: `Paid ${Math.round(h.costBasis)} wholesale: never sells at a loss`, effect: `≥ ${minFloor}` });
  }
  return { floor, reasons };
}

export function rollSellSecret(rng: Rng, merchant: Merchant, good: Good, h: Holdings, recentSales: number, memory?: PlayerMemory): Priced {
  const { floor, reasons } = sellFloor(good, h, recentSales, rng);
  const need = sellerNeed(h, rng);
  const seed = Math.floor(rng() * 2 ** 31);
  const markup = 1.35 + 0.45 * rng() + 0.2 * merchant.personality.bluff;
  return {
    secret: { side: "sell", merchantId: merchant.id, goodId: good.id, floor, need, seed, listPrice: Math.round(floor * markup), ...memoryLevels(memory) },
    reasons,
  };
}

// ---------- merchant buying from a player ----------

/**
 * The ceiling a merchant commits to when buying one unit of the good it wants.
 * It wants the good more when it has few, and can never commit more than it can pay.
 * `escrow` is what the contract locks from the merchant's purse for this haggle.
 */
export function buyCeiling(good: Good, h: Holdings, rng: Rng) {
  const reasons: Reason[] = [{ label: `Street value of ${good.name}`, effect: String(good.baseValue) }];
  const want = h.stock === 0 ? 1.2 : h.stock === 1 ? 1.08 : 1 - 0.06 * Math.min(4, h.stock - 1);
  reasons.push({ label: h.stock === 0 ? "Has none and wants one" : `Already has ${h.stock}`, effect: pct(want) });
  const noise = 0.85 + 0.2 * rng();
  const escrow = Math.floor(h.coins * MAX_PURSE_SHARE);
  let ceiling = Math.round(good.baseValue * want * noise);
  if (ceiling > escrow) {
    ceiling = escrow;
    reasons.push({ label: `Only ${h.coins} coins in the purse`, effect: `≤ ${escrow}` });
  }
  return { ceiling, escrow, reasons };
}

export function rollBuySecret(rng: Rng, merchant: Merchant, good: Good, h: Holdings, memory?: PlayerMemory): Priced & { escrow: number } | null {
  const { ceiling, escrow, reasons } = buyCeiling(good, h, rng);
  if (ceiling < 2) return null; // too broke to buy anything
  const need: Need = h.stock === 0 ? "rent_due" : h.stock >= 3 ? "hoarding" : pickWeighted(rng, [["restocking", 2], ["comfortable", 2]]);
  const seed = Math.floor(rng() * 2 ** 31);
  const opening = 0.55 + 0.2 * rng() - 0.15 * merchant.personality.bluff;
  return {
    secret: { side: "buy", merchantId: merchant.id, goodId: good.id, floor: ceiling, need, seed, listPrice: Math.max(1, Math.round(ceiling * opening)), ...memoryLevels(memory) },
    reasons,
    escrow,
  };
}

// ---------- restocking at the docks ----------

/** Should this merchant restock now, and what may it spend? Null when it shouldn't or can't. */
export function restockPlan(good: Good, h: Holdings, spentToday: number, cap = DAILY_CAP.merchant) {
  if (h.stock > RESTOCK_AT) return null;
  const fee = runnerFee(LOT_SIZE);
  const budget = Math.min(Math.round(good.baseValue * WHOLESALE_BID_MAX * LOT_SIZE), h.coins - fee, cap - spentToday - fee);
  if (budget < good.baseValue * 0.35 * LOT_SIZE) return null; // can't afford a lot: the stall runs dry
  return { qty: LOT_SIZE, maxSpend: budget, runnerFee: fee };
}

/**
 * The wholesaler's floor for a lot. Cheap in the morning, dearer as the day's supply runs down.
 * The wholesaler is an agent too: it commits this before haggling, like any merchant.
 */
export function rollWholesaleSecret(rng: Rng, wholesaler: Merchant, good: Good, qty: number, lotsSoldToday: number): Priced {
  const reasons: Reason[] = [{ label: `${qty} × ${good.name} at the docks`, effect: String(good.baseValue * qty) }];
  const supply = 1 + 0.06 * Math.min(8, lotsSoldToday);
  if (lotsSoldToday) reasons.push({ label: `${lotsSoldToday} lots sold today`, effect: pct(supply) });
  const unit = good.baseValue * (0.42 + 0.12 * rng()) * supply;
  const floor = Math.round(unit * qty);
  const seed = Math.floor(rng() * 2 ** 31);
  return {
    secret: { side: "sell", merchantId: wholesaler.id, goodId: good.id, floor, need: "restocking", seed, listPrice: Math.round(floor * (1.45 + 0.3 * rng())), grudge: 0, loyalty: 0 },
    reasons,
  };
}

/** Average cost per unit after buying `qty` more at `price` for the lot. */
export const nextCostBasis = (h: Holdings, qty: number, price: number) =>
  h.stock + qty === 0 ? 0 : (h.costBasis * h.stock + price) / (h.stock + qty);

// ---------- rival traders ----------

export interface Route {
  buyFrom: string;
  sellTo: string;
  goodId: string;
  /** Estimated profit per unit from street values; the traders don't know the secrets either. */
  edge: number;
}

/**
 * A trader looks for a good one merchant sells and another wants, and goes when it can afford a
 * unit and the stall isn't empty. Traders compete with the player for the same stock.
 */
export function traderRoute(merchants: Merchant[], goods: Record<string, Good>, stock: Record<string, number>, coins: number, rng: Rng): Route | null {
  const routes: Route[] = [];
  for (const seller of merchants)
    for (const buyer of merchants) {
      if (seller.id === buyer.id || seller.goodId !== buyer.buysGoodId) continue;
      if ((stock[seller.id] ?? 0) <= 0) continue;
      const g = goods[seller.goodId];
      if (coins < g.baseValue * 1.2) continue;
      routes.push({ buyFrom: seller.id, sellTo: buyer.id, goodId: g.id, edge: Math.round(g.baseValue * 0.15) });
    }
  return routes.length ? routes[Math.floor(rng() * routes.length)] : null;
}
