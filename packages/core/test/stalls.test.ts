import { describe, expect, it } from "vitest";
import { LICENCE_LEVEL, LICENCE_PRICE, MAX_DEED_PRICE, UNLOCKS, customerWouldBuy, mulberry32, ownerTake, sellerTake, suggestedAsk, traderWouldBuy } from "../src/index.js";

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

  it("a deed sale keeps 5% for the street, like the contract", () => {
    expect(sellerTake(300)).toBe(285);
    expect(sellerTake(19)).toBe(19);
    expect(sellerTake(5000)).toBe(4750);
  });

  it("a busy stall's deed asks more, within the market's limit", () => {
    expect(suggestedAsk(0)).toBe(LICENCE_PRICE);
    expect(suggestedAsk(100)).toBe(300);
    expect(suggestedAsk(100)).toBeGreaterThan(suggestedAsk(20));
    expect(suggestedAsk(1e6)).toBe(MAX_DEED_PRICE);
  });
});
