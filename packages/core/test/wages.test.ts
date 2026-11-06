import { describe, expect, it } from "vitest";
import { BROKE_BELOW, CANAL_ORIGIN, DOCK, DOCK_WAGE, isBroke, routeMetres } from "../src/index.js";

describe("dock work", () => {
  it("is only for players who are actually broke", () => {
    expect(isBroke(0)).toBe(true);
    expect(isBroke(BROKE_BELOW - 1)).toBe(true);
    expect(isBroke(BROKE_BELOW)).toBe(false);
  });

  it("pays enough to buy a lamp and start trading again", () => {
    expect(DOCK_WAGE).toBeGreaterThanOrEqual(25 * 1.2);
  });

  it("the docks are a short walk from the stalls", () => {
    const m = routeMetres(CANAL_ORIGIN, DOCK);
    expect(m).toBeGreaterThan(1000);
    expect(m).toBeLessThan(2000);
  });
});
