import { describe, expect, it } from "vitest";
import {
  BOTS,
  CUSTOMER_HOLD_MAX,
  WALK_IN_CHANCE,
  customerShopping,
  DAILY_CAP,
  GOODS,
  LOT_SIZE,
  MERCHANTS,
  WHOLESALER,
  askPrice,
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
    // 71 coins can't meet Wu's floor for 4 saffron (67 and up, plus the runner): don't turn up.
    expect(restockPlan(GOODS.saffron, { coins: 71, stock: 0, costBasis: 0 }, 0)).toBeNull();
    expect(restockPlan(GOODS.saffron, { coins: 119, stock: 0, costBasis: 0 }, 0)).not.toBeNull();
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

describe("trade loop balance", () => {
  // Buy a good at Auntie Wu's board (the cheapest place), sell it to the merchant who wants it.
  // Haggling well should pay; taking the opening bid should about break even, never a sure win.
  const margin = (sellBot: keyof typeof BOTS, seed: number) => {
    const rng = mulberry32(seed);
    let paid = 0, got = 0;
    for (let i = 0; i < 400; i++) {
      for (const buyer of MERCHANTS) {
        const good = GOODS[buyer.buysGoodId];
        const b = playSecret(rollBuySecret(rng, buyer, good, { coins: 300, stock: 1, costBasis: 0 })!.secret, buyer.personality, BOTS[sellBot]).state;
        if (b.status !== "deal") continue;
        paid += askPrice(good.baseValue, 8, 0)!;
        got += b.dealPrice!;
      }
    }
    return got / paid - 1;
  };
  it.each([1, 2, 3])("haggling well profits, taking the opening bid about breaks even (seed %i)", (seed) => {
    expect(margin("sellReader", seed)).toBeGreaterThan(0.1);
    const careless = margin("sucker", seed);
    expect(careless).toBeGreaterThan(-0.05);
    expect(careless).toBeLessThan(0.1);
  });
  it("even when Wu is low on stock and dearest, no merchant's opening bid is a sure win against her", () => {
    const rng = mulberry32(9);
    for (const buyer of MERCHANTS) {
      const good = GOODS[buyer.buysGoodId];
      const wuDearest = Math.round(good.baseValue * 1.08);
      let above = 0;
      for (let i = 0; i < 500; i++) if (rollBuySecret(rng, buyer, good, { coins: 300, stock: 1, costBasis: 0 })!.secret.listPrice > wuDearest) above++;
      expect(above / 500).toBeLessThan(0.2);
    }
  });
});

describe("customers shop at the bazaar", () => {
  it("walk-ins fit the smallest customer key allowance (0.8 NEAR on 12 Nov) through judging (13 days)", () => {
    const perCustomerPerDay = (WALK_IN_CHANCE * (86_400 / 40)) / 5;
    const nearPerDay = 0.035 + perCustomerPerDay * 0.003;
    expect(nearPerDay * 13).toBeLessThan(0.8);
    expect(WALK_IN_CHANCE * (86_400 / 40)).toBeGreaterThan(40); // enough to move customer income to merchants
  });
  const rug = GOODS.rug;
  const rich = { coins: 300, held: 0, capLeft: 500 };
  it("walks in with a budget a little above the street value", () => {
    const p = customerShopping(rich, rug, 3, () => 0.5)!;
    expect(p.budget).toBeGreaterThan(rug.baseValue);
    expect(p.budget).toBeLessThanOrEqual(Math.round(rug.baseValue * 1.3));
  });
  it("stays home when stocked up, broke, capped, or the stall is empty", () => {
    expect(customerShopping({ ...rich, held: CUSTOMER_HOLD_MAX }, rug, 3, () => 0.5)).toBeNull();
    expect(customerShopping({ ...rich, coins: 10 }, rug, 3, () => 0.5)).toBeNull();
    expect(customerShopping({ ...rich, capLeft: 10 }, rug, 3, () => 0.5)).toBeNull();
    expect(customerShopping(rich, rug, 0, () => 0.5)).toBeNull();
  });
});
