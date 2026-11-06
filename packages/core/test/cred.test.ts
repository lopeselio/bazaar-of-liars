import { describe, expect, it } from "vitest";
import { canTake, credView, levelOf, titleOf, xpForLevel } from "../src/index.js";

describe("street cred", () => {
  it("levels follow the XP curve and back", () => {
    expect([0, 29, 30, 119, 120, 270, 480].map(levelOf)).toEqual([1, 1, 2, 2, 3, 4, 5]);
    for (let l = 1; l < 10; l++) expect(levelOf(xpForLevel(l))).toBe(l);
    expect(titleOf(1)).toBe("Newcomer");
    expect(titleOf(99)).toBe("Bazaar Legend");
  });

  it("levels unlock express and far-off jobs", () => {
    expect(canTake(1, { express: true, site: "owtc" }).ok).toBe(false);
    expect(canTake(2, { express: true, site: "owtc" }).ok).toBe(true);
    expect(canTake(2, { express: false, site: "timessq" })).toEqual({ ok: false, needs: 3 });
    expect(canTake(3, { express: true, site: "centralpark" }).ok).toBe(true);
  });

  it("a streak lapses after a missed day", () => {
    const raw = { xp: 100, streak: 4, best_streak: 6, last_day: 100 };
    expect(credView(raw, 100)).toMatchObject({ streak: 4, activeToday: true, level: 2, nextXp: 120 });
    expect(credView(raw, 101)).toMatchObject({ streak: 4, activeToday: false });
    expect(credView(raw, 102).streak).toBe(0);
  });
});
