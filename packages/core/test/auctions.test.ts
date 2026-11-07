import { describe, expect, it } from "vitest";
import { agentBid, bidCommitment, depositFor, mulberry32 } from "../src/index.js";

describe("cargo ship auctions", () => {
  it("hashes a bid exactly like the contract", () => {
    // Same vector as contracts/bazaar bid_commitment_matches_typescript.
    expect(bidCommitment("ship-1", "guest-0011223344556677", 130, "ffeeddccbbaa99887766554433221100")).toBe(
      "e10e213e549b9d04319420abddca6d9ce7f818e37bac0a776e02bebfa8fe9c67",
    );
  });

  it("deposits a round figure above the bid, within the purse", () => {
    expect(depositFor(130, 100, 500)).toBe(150);
    expect(depositFor(150, 100, 500)).toBe(200);
    expect(depositFor(130, 100, 140)).toBe(140);
    expect(depositFor(90, 100, 500)).toBe(100);
  });

  it("agents bid within their purse and cap, and only above the reserve", () => {
    const lot = { goodId: "saffron", qty: 5, reserve: 100, baseValue: 40 };
    const rng = mulberry32(3);
    const wu = agentBid({ kind: "wholesaler", stock: 0, coins: 1000, capLeft: 400 }, lot, rng)!;
    expect(wu).toBeGreaterThanOrEqual(100);
    expect(wu).toBeLessThanOrEqual(40 * 5);
    expect(agentBid({ kind: "wholesaler", stock: 0, coins: 1000, capLeft: 60 }, lot, rng)).toBeNull();
    expect(agentBid({ kind: "merchant", sells: "rug", stock: 0, coins: 1000, capLeft: 400 }, lot, rng)).toBeNull();
    expect(agentBid({ kind: "merchant", sells: "saffron", stock: 9, coins: 1000, capLeft: 400 }, lot, rng)).toBeNull();
    expect(agentBid({ kind: "runner", stock: 0, coins: 1000, capLeft: 400 }, lot, rng)).toBeNull();
  });
});
