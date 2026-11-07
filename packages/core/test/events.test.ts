import { describe, expect, it } from "vitest";
import { askMultiplier, bidMultiplier, bountyMultiplier, raidSeizes, tradersLieLow, type StreetEvent } from "../src/index.js";

const ev = (kind: StreetEvent["kind"], good_id = ""): StreetEvent => ({ id: "e", kind, good_id, start_ms: 1000, end_ms: 5000, seized: 0 });

describe("street events", () => {
  it("only apply while they're on", () => {
    expect(bidMultiplier(ev("festival"), "rug", 2000)).toBe(1.25);
    expect(bidMultiplier(ev("festival"), "rug", 5000)).toBe(1);
    expect(bidMultiplier(null, "rug", 2000)).toBe(1);
  });
  it("a shortage is about one good", () => {
    expect(askMultiplier(ev("shortage", "lamp"), "lamp", 2000)).toBe(1.3);
    expect(askMultiplier(ev("shortage", "lamp"), "rug", 2000)).toBe(1);
    expect(bidMultiplier(ev("shortage", "lamp"), "lamp", 2000)).toBe(1.4);
  });
  it("festivals bring orders, raids send traders to ground", () => {
    expect(bountyMultiplier(ev("festival"), 2000)).toBe(1.25);
    expect(tradersLieLow(ev("raid"), 2000)).toBe(true);
    expect(tradersLieLow(ev("festival"), 2000)).toBe(false);
  });
  it("a raid takes what's over the limit", () => {
    expect(raidSeizes({ rug: 8, lamp: 2, saffron: 5 })).toBe(3);
  });
});
