import { describe, expect, it } from "vitest";
import { BARTER_CHANCE, barterQuote, pickBarter } from "../src/index.js";

const GOOD_VALUES_FOR_TEST: Record<string, number> = { rug: 60, saffron: 40, lamp: 25 };

describe("barter through NEAR Intents", () => {
  it("prices each merchant's barter so Wu keeps her edge", () => {
    // Farrukh sells rugs (60), uses lamps (25): 1 rug for 2 lamps (Wu credits 51, pays 50).
    expect(barterQuote({ sells: "rug", uses: "lamp" }, { sells: 4, uses: 0 }, 280, GOOD_VALUES_FOR_TEST)).toEqual({ give: { good: "rug", qty: 1 }, get: { good: "lamp", qty: 2 } });
    // Zaria sells saffron (40), uses rugs (60): 2 saffron (credit 68) for 1 rug.
    expect(barterQuote({ sells: "saffron", uses: "rug" }, { sells: 5, uses: 0 }, 300, GOOD_VALUES_FOR_TEST)).toEqual({ give: { good: "saffron", qty: 2 }, get: { good: "rug", qty: 1 } });
    // Tobin sells lamps (25), uses saffron (40): 2 lamps (credit 42.5) for 1 saffron.
    expect(barterQuote({ sells: "lamp", uses: "saffron" }, { sells: 9, uses: 0 }, 300, GOOD_VALUES_FOR_TEST)).toEqual({ give: { good: "lamp", qty: 2 }, get: { good: "saffron", qty: 1 } });
  });

  it("never gives Wu more value than she gives back, after her edge", () => {
    for (const [sells, uses] of [["rug", "lamp"], ["saffron", "rug"], ["lamp", "saffron"]] as const) {
      const q = barterQuote({ sells, uses }, { sells: 9, uses: 0 }, 300, GOOD_VALUES_FOR_TEST)!;
      const given = q.give.qty * GOOD_VALUES_FOR_TEST[sells]!, got = q.get.qty * GOOD_VALUES_FOR_TEST[uses]!;
      expect(got).toBeLessThanOrEqual(given * 0.85 + 1e-9);
      expect(got).toBeGreaterThan(given * 0.5);
    }
  });

  it("only when the merchant has run out, keeps its shelf, and Wu keeps a reserve", () => {
    const m = { sells: "saffron", uses: "rug" };
    expect(barterQuote(m, { sells: 5, uses: 1 }, 300, GOOD_VALUES_FOR_TEST)).toBeNull();
    expect(barterQuote(m, { sells: 2, uses: 0 }, 300, GOOD_VALUES_FOR_TEST)).toBeNull();
    expect(barterQuote(m, { sells: 5, uses: 0 }, 20, GOOD_VALUES_FOR_TEST)).toBeNull();
  });

  it("happens rarely: about BARTER_CHANCE of ticks", () => {
    let n = 0, i = 0;
    const rng = () => ((i = (i * 9301 + 49297) % 233280) / 233280);
    for (let t = 0; t < 20000; t++) if (pickBarter(["farrukh"], rng)) n++;
    expect(n / 20000).toBeGreaterThan(BARTER_CHANCE * 0.6);
    expect(n / 20000).toBeLessThan(BARTER_CHANCE * 1.6);
  });
});
