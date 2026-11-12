import { describe, expect, it } from "vitest";
import { advanceFor, LOAN_WRITE_OFF_MS, owedOn, repaymentFor, tradingFloat, TRADER_ADVANCE, WU_RESERVE } from "../src/relief.js";

const wu = { coins: 979, spentToday: 0 };
const farrukh = { id: "farrukh", kind: "merchant", goodId: "rug", coins: 8, owed: 0 };

describe("Auntie Wu's advances", () => {
  it("a broke merchant gets enough for one lot plus the runner; a trader enough for one good", () => {
    expect(tradingFloat(farrukh)).toBe(Math.ceil(60 * 0.7 * 4) + 7);
    expect(advanceFor(farrukh, wu)).toEqual({ amount: tradingFloat(farrukh) - 8 });
    expect(advanceFor({ id: "ivy", kind: "trader", coins: 19, owed: 0 }, wu)).toEqual({ amount: TRADER_ADVANCE - 19 });
  });

  it("one loan at a time, nothing for anyone who can already trade, and nobody else", () => {
    expect(advanceFor({ ...farrukh, owed: 50 }, wu)).toHaveProperty("skip");
    expect(advanceFor({ ...farrukh, coins: 400 }, wu)).toHaveProperty("skip");
    expect(advanceFor({ id: "vesey", kind: "customer", coins: 0, owed: 0 }, wu)).toHaveProperty("skip");
  });

  it("Wu keeps her reserve and room under her cap for dock wages", () => {
    expect(advanceFor(farrukh, { coins: WU_RESERVE + 100, spentToday: 0 })).toHaveProperty("skip");
    expect(advanceFor(farrukh, { coins: 979, spentToday: 300 })).toHaveProperty("skip");
    expect(advanceFor(farrukh, { coins: 979, spentToday: 100 })).toHaveProperty("amount");
  });

  it("repays in full only once the borrower keeps enough to trade, within its own cap", () => {
    const b = { ...farrukh, owed: 170, spentToday: 0, dailyCap: 400 };
    expect(repaymentFor({ ...b, coins: 200 })).toBeNull();
    expect(repaymentFor({ ...b, coins: 170 + tradingFloat(b) })).toBe(170);
    expect(repaymentFor({ ...b, coins: 1000, spentToday: 300 })).toBeNull();
    expect(repaymentFor({ ...b, owed: 0, coins: 1000 })).toBeNull();
  });

  it("writes a loan off after 8 hours, so a trader that lost it can be staked again", () => {
    const loan = { amount: 61, at: 1000 };
    expect(owedOn(loan, 1000 + LOAN_WRITE_OFF_MS - 1)).toBe(61);
    expect(owedOn(loan, 1000 + LOAN_WRITE_OFF_MS)).toBe(0);
    expect(owedOn(undefined, 5)).toBe(0);
  });
});
