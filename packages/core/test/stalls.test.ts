import { describe, expect, it } from "vitest";
import { LICENCE_LEVEL, UNLOCKS, customerWouldBuy, mulberry32, ownerTake, traderWouldBuy } from "../src/index.js";

describe("player stalls", () => {
  it("the street keeps 10% of each sale", () => {
    expect(ownerTake(50)).toBe(45);
    expect(ownerTake(9)).toBe(9);
    expect(ownerTake(100)).toBe(90);
  });

  it("traders buy bargains often and overpriced goods never", () => {
    const rng = mulberry32(1);
    const rate = (price: number) => {
      let n = 0;
      for (let i = 0; i < 2000; i++) n += +traderWouldBuy(price, 60, 300, rng);
      return n / 2000;
    };
    expect(rate(40)).toBeGreaterThan(rate(55));
    expect(rate(55)).toBeGreaterThan(0.05);
    expect(rate(70)).toBe(0);
    expect(traderWouldBuy(40, 60, 30, rng)).toBe(false); // can't afford it
  });

  it("customers only buy within their bounty", () => {
    expect(customerWouldBuy(80, 90)).toBe(true);
    expect(customerWouldBuy(95, 90)).toBe(false);
  });

  it("the licence is listed among the level unlocks", () => {
    expect(UNLOCKS.some((u) => u.level === LICENCE_LEVEL && /licence/.test(u.what))).toBe(true);
  });
});
