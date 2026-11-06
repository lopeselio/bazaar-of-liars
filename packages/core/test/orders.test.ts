import { describe, expect, it } from "vitest";
import { CANAL_ORIGIN, CUSTOMERS, DROP_SITES, GOODS, fare, impliedMode, mulberry32, orderTerms, routeMetres, siteById } from "../src/index.js";

const values = Object.fromEntries(Object.values(GOODS).map((g) => [g.id, g.baseValue]));

describe("delivery jobs", () => {
  it("every customer sits at a known drop site and wants goods Canal Street sells", () => {
    for (const c of CUSTOMERS) {
      expect(siteById(c.siteId)).toBeTruthy();
      for (const g of c.wants) expect(GOODS[g]).toBeTruthy();
    }
    expect(new Set(DROP_SITES.map((s) => s.id)).size).toBe(DROP_SITES.length);
  });

  it("travel mode comes from distance and time, not from what the player claims", () => {
    expect(impliedMode(1000, 200_000)).toBe("foot"); // 5 m/s
    expect(impliedMode(3000, 200_000)).toBe("bike"); // 15 m/s
    expect(impliedMode(6000, 200_000)).toBe("cab"); // 30 m/s
    expect(impliedMode(12000, 200_000)).toBe("heli"); // 60 m/s
    expect(impliedMode(6000, 20_000)).toBeNull(); // 300 m/s: nobody gets there that fast
  });

  it("walking and cycling are free; cabs and helicopters cost more the further you go", () => {
    expect(fare("foot", 5000)).toBe(0);
    expect(fare("bike", 5000)).toBe(0);
    expect(fare("cab", 5000)).toBeGreaterThan(fare("cab", 1000));
    expect(fare("heli", 5000)).toBeGreaterThan(fare("cab", 5000));
  });

  it("a normal order pays more than the good is worth, even after a cab", () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 500; i++) {
      const c = CUSTOMERS[i % CUSTOMERS.length];
      const t = orderTerms(rng, c, values);
      expect(t.bounty - fare("cab", t.metres)).toBeGreaterThan(values[t.goodId]);
      expect(c.wants).toContain(t.goodId);
    }
  });

  it("express windows are too short to walk but long enough for a cab", () => {
    const rng = mulberry32(9);
    let seen = 0;
    for (let i = 0; i < 400; i++) {
      const c = CUSTOMERS[i % CUSTOMERS.length];
      const t = orderTerms(rng, c, values);
      if (!t.express || t.metres < 3000) continue;
      seen++;
      const cabMs = (t.metres / 30) * 1000; // a cab averaging 30 m/s
      const runMs = (t.metres / 8.2) * 1000; // flat-out running, no time to buy the good
      expect(t.windowMs).toBeGreaterThan(cabMs);
      expect(t.windowMs).toBeLessThan(runMs + 90_000);
    }
    expect(seen).toBeGreaterThan(20);
  });

  it("routes are measured from Canal Street", () => {
    expect(routeMetres(CANAL_ORIGIN, siteById("timessq")!)).toBeGreaterThan(5000);
    expect(routeMetres(CANAL_ORIGIN, siteById("owtc")!)).toBeLessThan(2000);
  });
});
