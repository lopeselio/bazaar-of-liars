/**
 * Price boards and trade routes: the map is the market.
 *
 * Auntie Wu posts sell prices at the Pier 34 docks; the customers uptown post buy prices outside
 * their doors. The further a buyer is from Canal Street, the more it pays, and the more it has
 * bought today, the less. So there's a spread to carry: buy at the docks, travel, sell uptown.
 * Every trade settles onchain: Wu never sells below what her stock cost her (the contract checks),
 * and a buyer pays exactly what it signed for with its own key.
 */
import { CUSTOMERS, CANAL_ORIGIN, routeMetres, siteById } from "./orders.js";
import { DOCK } from "./wages.js";

export interface Board {
  id: string;
  name: string;
  /** The agent behind the board. */
  agentId: string;
  /** "sells": the agent sells to players; "buys": the agent buys from players. */
  kind: "sells" | "buys";
  district: string;
  x: number;
  z: number;
  goods: string[];
}

/** Wu keeps this many of each good back for the merchants' restocks. */
export const WU_KEEPS = 4;
/** How close to a board the player must be (metres). */
export const BOARD_REACH = 40;

export const BOARDS: Board[] = [
  { id: "docks", name: "Auntie Wu's wholesale", agentId: "wu", kind: "sells", district: "Pier 34", x: DOCK.x + 22, z: DOCK.z + 14, goods: ["rug", "saffron", "lamp"] },
  ...CUSTOMERS.map((c): Board => {
    const site = siteById(c.siteId)!;
    // Beside the delivery drop point, not on it.
    return { id: c.id, name: c.name, agentId: c.id, kind: "buys", district: site.district, x: site.x - 16, z: site.z + 6, goods: c.wants };
  }),
];
export const boardById = (id: string) => BOARDS.find((b) => b.id === id);

/** Wu's price for one unit: cheaper the more she has, never below her cost (the contract checks). */
export function askPrice(baseValue: number, stock: number, costBasis: number): number | null {
  if (stock <= WU_KEEPS) return null;
  const scarcity = Math.max(0, 1 - stock / 12);
  return Math.max(Math.ceil(costBasis), Math.round(baseValue * (0.78 + 0.3 * scarcity)));
}

/**
 * A buyer's price for one unit: more the further it is from Canal Street (up to +35%), less for
 * each unit it has already bought today. Null once it's had enough.
 */
export function bidPrice(baseValue: number, board: { x: number; z: number }, boughtToday: number): number | null {
  const km = routeMetres(CANAL_ORIGIN, board) / 1000;
  const p = baseValue * (1.05 + Math.min(0.35, km * 0.07)) * (1 - 0.08 * boughtToday);
  return p < baseValue * 0.95 ? null : Math.round(p);
}

export interface PricedBoard extends Board {
  prices: Record<string, number | null>;
}

/** The best spread on the map right now: buy at one board, sell at another. */
export function bestRoute(boards: PricedBoard[]): { goodId: string; buyAt: string; sellAt: string; buy: number; sell: number; profit: number; metres: number } | null {
  let best: ReturnType<typeof bestRoute> = null;
  for (const s of boards.filter((b) => b.kind === "sells"))
    for (const b of boards.filter((x) => x.kind === "buys"))
      for (const g of b.goods) {
        const buy = s.prices[g];
        const sell = b.prices[g];
        if (buy == null || sell == null || sell <= buy) continue;
        if (!best || sell - buy > best.profit) best = { goodId: g, buyAt: s.id, sellAt: b.id, buy, sell, profit: sell - buy, metres: routeMetres(s, b) };
      }
  return best;
}
