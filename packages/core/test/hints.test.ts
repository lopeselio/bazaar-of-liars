import { describe, expect, it } from "vitest";
import { haggleHint } from "../src/hints.js";

const base = { side: "sell" as const, askBefore: 100, offer: 40, tell: "relaxed" as const, name: "Tobin" };

describe("haggle hints", () => {
  it("says when a merchant barely moved toward the offer", () => {
    expect(haggleHint({ ...base, askAfter: 97 })).toMatch(/barely moved \(3 coins\)/);
    expect(haggleHint({ ...base, askAfter: 100 })).toMatch(/barely moved\./);
  });
  it("stays quiet when the merchant moved a fair way", () => {
    expect(haggleHint({ ...base, askAfter: 90 })).toBeNull();
  });
  it("warns about the mood when an irritated merchant got a far-off offer", () => {
    expect(haggleHint({ ...base, askAfter: 90, tell: "irritated" })).toMatch(/losing patience/);
    expect(haggleHint({ ...base, offer: 85, askAfter: 99, tell: "irritated" })).toMatch(/barely moved \(1 coin\)\. Hold your price/);
  });
  it("says nothing when the merchant looks firm (near its limit, so not budging is honest)", () => {
    expect(haggleHint({ ...base, askAfter: 100, tell: "firm" })).toBeNull();
  });
  it("handles a missing tell and an irritated buyer", () => {
    expect(haggleHint({ ...base, askAfter: 99, tell: null })).toMatch(/barely moved/);
    expect(haggleHint({ side: "buy", askBefore: 30, offer: 60, askAfter: 33, tell: "irritated", name: "Zaria" })).toMatch(/losing patience/);
  });
  it("mirrors for a player selling to a buying merchant", () => {
    const sell = { side: "buy" as const, askBefore: 30, offer: 60, tell: "relaxed" as const, name: "Zaria" };
    expect(haggleHint({ ...sell, askAfter: 31 })).toMatch(/barely moved \(1 coin\)/);
    expect(haggleHint({ ...sell, askAfter: 36 })).toBeNull();
    expect(haggleHint({ ...sell, offer: 20, askAfter: 30 })).toBeNull(); // asked less than the bid
  });
});
