import { describe, expect, it } from "vitest";
import {
  BOTS,
  DAILY_CAP,
  GOODS,
  LOT_SIZE,
  MERCHANTS,
  WHOLESALER,
  buyCeiling,
  mulberry32,
  nextCostBasis,
  playSecret,
  restockPlan,
  rollBuySecret,
  rollSellSecret,
  rollWholesaleSecret,
  sellFloor,
  traderRoute,
} from "../src/index.js";

const rng = mulberry32(42);

describe("Canal Street economy", () => {
  it("a merchant never commits a floor below what its stock cost", () => {
    for (let i = 0; i < 2000; i++) {
      const g = GOODS.saffron;
      const h = { coins: Math.floor(rng() * 300), stock: Math.floor(rng() * 9), costBasis: rng() * 70 };
      const { floor } = sellFloor(g, h, Math.floor(rng() * 8), rng);
      expect(floor).toBeGreaterThanOrEqual(Math.ceil(h.costBasis) + 1);
    }
  });

  it("scarcity and demand raise the floor", () => {
    const avg = (stock: number, sales: number) => {
      const r = mulberry32(7);
      let s = 0;
      for (let i = 0; i < 400; i++) s += sellFloor(GOODS.rug, { coins: 100, stock, costBasis: 0 }, sales, r).floor;
      return s / 400;
    };
    expect(avg(1, 0)).toBeGreaterThan(avg(4, 0));
    expect(avg(8, 0)).toBeLessThan(avg(4, 0));
    expect(avg(4, 5)).toBeGreaterThan(avg(4, 0));
  });

  it("a buying merchant never commits more than it escrows, nor escrows more than it holds", () => {
    for (let i = 0; i < 2000; i++) {
      const h = { coins: Math.floor(rng() * 200), stock: Math.floor(rng() * 5), costBasis: 0 };
      const { ceiling, escrow } = buyCeiling(GOODS.rug, h, rng);
      expect(escrow).toBeLessThanOrEqual(h.coins);
      expect(ceiling).toBeLessThanOrEqual(escrow);
      const s = rollBuySecret(rng, MERCHANTS[1], GOODS.rug, h);
      if (s) expect(s.secret.floor).toBeLessThanOrEqual(s.escrow);
    }
  });

  it("restocks only when low, and never plans past its purse or daily cap", () => {
    expect(restockPlan(GOODS.lamp, { coins: 500, stock: 5, costBasis: 10 }, 0)).toBeNull();
    expect(restockPlan(GOODS.rug, { coins: 20, stock: 0, costBasis: 0 }, 0)).toBeNull();
    for (let i = 0; i < 1000; i++) {
      const h = { coins: Math.floor(rng() * 400), stock: Math.floor(rng() * 3), costBasis: 0 };
      const spent = Math.floor(rng() * 400);
      const p = restockPlan(GOODS.saffron, h, spent);
      if (!p) continue;
      expect(p.maxSpend + p.runnerFee).toBeLessThanOrEqual(h.coins);
      expect(spent + p.maxSpend + p.runnerFee).toBeLessThanOrEqual(DAILY_CAP.merchant);
    }
  });

  it("agent-to-agent haggles at the docks respect both the wholesaler's floor and the buyer's budget", () => {
    let deals = 0;
    for (let i = 0; i < 1500; i++) {
      const good = Object.values(GOODS)[i % 3];
      const { secret } = rollWholesaleSecret(rng, WHOLESALER, good, LOT_SIZE, i % 6);
      const budget = Math.round(good.baseValue * LOT_SIZE * (0.4 + 0.4 * rng()));
      const { state } = playSecret(secret, WHOLESALER.personality, BOTS.sharp, budget);
      if (state.status === "deal") {
        deals++;
        expect(state.dealPrice!).toBeGreaterThanOrEqual(secret.floor);
        expect(state.dealPrice!).toBeLessThanOrEqual(budget);
      }
    }
    expect(deals).toBeGreaterThan(300); // restocking usually works
  });

  it("cost basis is a running average", () => {
    expect(nextCostBasis({ coins: 0, stock: 0, costBasis: 0 }, 4, 100)).toBe(25);
    expect(nextCostBasis({ coins: 0, stock: 2, costBasis: 10 }, 4, 100)).toBe(20);
  });

  it("traders only pick routes they can afford from stalls with stock", () => {
    const stock = { farrukh: 0, zaria: 3, tobin: 2 };
    for (let i = 0; i < 200; i++) {
      const r = traderRoute(MERCHANTS, GOODS, stock, 100, rng);
      expect(r?.buyFrom).not.toBe("farrukh");
    }
    expect(traderRoute(MERCHANTS, GOODS, stock, 5, rng)).toBeNull();
  });

  it("selling secrets carry their reasons for the tooltip", () => {
    const p = rollSellSecret(rng, MERCHANTS[0], GOODS.rug, { coins: 100, stock: 1, costBasis: 70 }, 2);
    expect(p.reasons.map((r) => r.label).join(" ")).toMatch(/Only 1 left/);
    expect(p.secret.floor).toBeGreaterThanOrEqual(71);
  });

  it("a trader selling to a merchant never gets more than the merchant's ceiling", () => {
    let deals = 0;
    for (let i = 0; i < 1000; i++) {
      const p = rollBuySecret(rng, MERCHANTS[1], GOODS.rug, { coins: 150, stock: i % 3, costBasis: 0 });
      if (!p) continue;
      const { state } = playSecret(p.secret, MERCHANTS[1].personality, BOTS.seller);
      if (state.status === "deal") {
        deals++;
        expect(state.dealPrice!).toBeLessThanOrEqual(p.secret.floor);
      }
    }
    expect(deals).toBeGreaterThan(300);
  });
});
