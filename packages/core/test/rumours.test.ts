import { describe, expect, it } from "vitest";
import { INFORMANTS, claimHolds, makeClaim, mulberry32, tipCommitment, type MerchantStock } from "../src/index.js";

const street: MerchantStock[] = [
  { id: "farrukh", sells: "rug", sellsStock: 5, buys: "lamp", buysStock: 0 },
  { id: "zaria", sells: "saffron", sellsStock: 1, buys: "rug", buysStock: 2 },
  { id: "tobin", sells: "lamp", sellsStock: 8, buys: "saffron", buysStock: 1 },
];

describe("the rumour network", () => {
  it("hashes a tip exactly like the contract", () => {
    // Same vector as contracts/bazaar tip_commitment_matches_typescript.
    expect(tipCommitment("tip-1", "vex", { agent_id: "zaria", good_id: "saffron", at_most: true, n: 3 }, 1_120_000, "ffeeddccbbaa99887766554433221100")).toBe(
      "ee48273145f98e3325e11bb2d95448b3d862fa4db697505a02c1f20e49dbee6c",
    );
  });

  it("honest tips are true right now, lies are false right now", () => {
    const rng = mulberry32(11);
    for (const inf of INFORMANTS)
      for (let i = 0; i < 200; i++) {
        const { claim, honest } = makeClaim(rng, inf, street);
        const m = street.find((s) => s.id === claim.agent_id)!;
        const stock = claim.good_id === m.sells ? m.sellsStock : m.buysStock;
        expect(claimHolds(claim, stock)).toBe(honest);
      }
  });

  it("informants lie at about their secret rate", () => {
    const rng = mulberry32(5);
    const lulu = INFORMANTS.find((i) => i.id === "lulu")!;
    const honest = Array.from({ length: 2000 }, () => makeClaim(rng, lulu, street).honest).filter(Boolean).length / 2000;
    expect(honest).toBeGreaterThan(0.25);
    expect(honest).toBeLessThan(0.35);
  });
});
