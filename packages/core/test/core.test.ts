import { describe, expect, it } from "vitest";
import {
  BOTS,
  GOODS,
  MERCHANTS,
  commit,
  commitmentPreimage,
  mulberry32,
  openHaggle,
  respond,
  acceptAsk,
  callBluff,
  canCall,
  holdReply,
  leftOnTable,
  rollSecret,
  verifyCommitment,
} from "../src/index.js";
import { playBot, playSession } from "../src/play.js";

describe("commitments", () => {
  const secret = rollSecret(mulberry32(1), MERCHANTS[0], GOODS.rug);
  const salt = "00112233445566778899aabbccddeeff";

  it("verifies the original secret", () => {
    expect(verifyCommitment(commit(secret, salt), secret, salt)).toBe(true);
  });

  it("rejects a changed floor, need, list price or salt", () => {
    const c = commit(secret, salt);
    expect(verifyCommitment(c, { ...secret, floor: secret.floor - 1 }, salt)).toBe(false);
    expect(verifyCommitment(c, { ...secret, need: "hoarding" }, salt)).toBe(false);
    expect(verifyCommitment(c, { ...secret, listPrice: secret.listPrice + 1 }, salt)).toBe(false);
    expect(verifyCommitment(c, secret, salt.replace("0", "1"))).toBe(false);
  });

  it("has a stable canonical preimage (contract must match byte-for-byte)", () => {
    const s = { side: "sell" as const, merchantId: "farrukh", goodId: "rug", floor: 52, need: "rent_due" as const, seed: 7, listPrice: 80, grudge: 2, loyalty: 1 };
    expect(commitmentPreimage(s, "ab")).toBe("bazaar-v2|sell|farrukh|rug|52|rent_due|7|80|2|1|ab");
    expect(commit(s, "ab")).toMatch(/^[0-9a-f]{64}$/);
    // Shared vectors with contracts/bazaar (commitment_matches_typescript).
    const salt = "00112233445566778899aabbccddeeff";
    expect(commit({ ...s, grudge: 0, loyalty: 0 }, salt)).toBe("407317eee375123b66094f34a115fc6ce18bebb5051b02da3bf9637bb8bfc716");
    expect(
      commit({ side: "buy", merchantId: "zaria", goodId: "rug", floor: 70, need: "restocking", seed: 9, listPrice: 40, grudge: 0, loyalty: 0 }, salt),
    ).toBe("3f5829091774f4e6bae193be28c7b402e0bfc653e8b98121d24c05c40459c1f3");
  });
});

describe("rules engine", () => {
  it("never deals or counters below the secret floor (fuzz)", () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 3000; i++) {
      const m = MERCHANTS[i % MERCHANTS.length];
      const secret = rollSecret(rng, m, GOODS[m.goodId]);
      const state = openHaggle(secret, m.personality);
      while (state.status === "open") {
        const offer = Math.floor(rng() * secret.listPrice * 1.2);
        const reply = respond(state, { price: offer, competitorPrice: rng() < 0.3 ? Math.floor(rng() * 80) : undefined });
        expect(reply.price).toBeGreaterThanOrEqual(secret.floor);
        if (reply.action === "accept") expect(state.dealPrice).toBeGreaterThanOrEqual(secret.floor);
      }
    }
  });

  it("is deterministic for a given seed", () => {
    const a = playBot(mulberry32(5), MERCHANTS[1], BOTS.splitter, { lowballs: 0, deals: 0 });
    const b = playBot(mulberry32(5), MERCHANTS[1], BOTS.splitter, { lowballs: 0, deals: 0 });
    expect(a.history).toEqual(b.history);
  });

  it("deals at the ask when the player meets it, never above", () => {
    const m = MERCHANTS[2];
    const secret = rollSecret(mulberry32(3), m, GOODS[m.goodId]);
    const state = openHaggle(secret, m.personality);
    const reply = respond(state, { price: state.ask + 50 });
    expect(reply.action).toBe("accept");
    expect(state.dealPrice).toBe(secret.listPrice);
  });

  it("walks away after repeated insults", () => {
    const m = MERCHANTS[1]; // hot temper
    const secret = rollSecret(mulberry32(8), m, GOODS[m.goodId]);
    const state = openHaggle(secret, m.personality);
    for (let i = 0; i < 5 && state.status === "open"; i++) respond(state, { price: 1 });
    expect(state.status).toBe("walked");
  });

  it("remembers lowballers (worse opening) and loyal customers (better opening), both sides", () => {
    const m = MERCHANTS[0];
    const sell = rollSecret(mulberry32(4), m, GOODS[m.goodId]);
    expect(openHaggle({ ...sell, grudge: 3 }, m.personality).ask).toBeGreaterThan(openHaggle(sell, m.personality).ask);
    expect(openHaggle({ ...sell, loyalty: 3 }, m.personality).ask).toBeLessThan(openHaggle(sell, m.personality).ask);
    const buy = rollSecret(mulberry32(4), m, GOODS[m.buysGoodId], "buy");
    expect(openHaggle({ ...buy, grudge: 3 }, m.personality).ask).toBeLessThan(openHaggle(buy, m.personality).ask);
    expect(openHaggle({ ...buy, loyalty: 3 }, m.personality).ask).toBeGreaterThan(openHaggle(buy, m.personality).ask);
  });

  it("sessions always terminate for every bot", () => {
    for (const bot of Object.values(BOTS))
      for (const m of MERCHANTS) expect(playSession(mulberry32(11), m, bot, 20)).toHaveLength(20);
  });
});

describe("merchants buying from the player", () => {
  it("never bids or pays above the secret ceiling (fuzz)", () => {
    const rng = mulberry32(77);
    for (let i = 0; i < 3000; i++) {
      const m = MERCHANTS[i % MERCHANTS.length];
      const secret = rollSecret(rng, m, GOODS[m.buysGoodId], "buy");
      const state = openHaggle(secret, m.personality);
      expect(state.ask).toBeLessThanOrEqual(secret.floor);
      while (state.status === "open") {
        const r = rng();
        const reply =
          r < 0.15 && canCall(state) ? callBluff(state) : respond(state, { price: Math.floor(secret.floor * (0.5 + rng())) });
        expect(reply.price).toBeLessThanOrEqual(secret.floor);
        if (reply.statedFloor !== undefined) expect(reply.statedFloor).toBeLessThanOrEqual(secret.floor);
        if (state.dealPrice !== undefined) expect(state.dealPrice).toBeLessThanOrEqual(secret.floor);
      }
    }
  });

  it("raises its bid toward the player's price", () => {
    const m = MERCHANTS[2];
    const secret = { ...rollSecret(mulberry32(5), m, GOODS[m.buysGoodId], "buy"), need: "rent_due" as const };
    const state = openHaggle(secret, m.personality);
    const before = state.ask;
    const r = respond(state, { price: secret.floor });
    if (r.action !== "accept") expect(r.price).toBeGreaterThan(before);
    expect(acceptAsk(state).action).toBe("accept");
    expect(leftOnTable(state)).toBeGreaterThanOrEqual(0);
  });
});

describe("calling a bluff", () => {
  /** Haggle with fair-ish offers until the merchant makes a claim. */
  function untilClaim(seed: number, side: "sell" | "buy" = "sell") {
    for (let k = 0; k < 500; k++) {
      const m = MERCHANTS[(seed + k) % 3];
      const secret = rollSecret(mulberry32(seed * 1000 + k), m, GOODS[side === "sell" ? m.goodId : m.buysGoodId], side);
      const state = openHaggle(secret, m.personality);
      for (let i = 0; i < 6 && state.status === "open" && !canCall(state); i++)
        respond(state, { price: side === "sell" ? Math.round(secret.floor * 0.95) : Math.round(secret.floor * 1.05) });
      if (canCall(state)) return { state, secret, m };
    }
    throw new Error("no claim found");
  }

  it("claims are sometimes lies and sometimes the truth, and never worse for the merchant than the truth", () => {
    let lies = 0,
      truths = 0;
    for (let s = 0; s < 200; s++) {
      const { state, secret } = untilClaim(s);
      expect(state.claim!).toBeGreaterThanOrEqual(secret.floor);
      expect(state.claim!).toBeLessThan(state.ask);
      if (state.claim! > secret.floor) lies++;
      else truths++;
    }
    expect(lies).toBeGreaterThan(20);
    expect(truths).toBeGreaterThan(20);
  });

  it("catching a lie drops the price close to the floor and ends the bluffing", () => {
    for (let s = 0; s < 200; s++) {
      const { state, secret } = untilClaim(s);
      if (state.claim! === secret.floor) continue;
      const before = state.ask;
      const r = callBluff(state);
      expect(r.call).toBe("caught");
      expect(r.price).toBeLessThan(before);
      expect(r.price).toBeGreaterThanOrEqual(secret.floor);
      expect(state.caught).toBe(true);
      expect(canCall(state)).toBe(false);
      return;
    }
    throw new Error("no lie found");
  });

  it("calling an honest merchant a liar costs you", () => {
    for (let s = 0; s < 200; s++) {
      const { state, secret } = untilClaim(s);
      if (state.claim! !== secret.floor) continue;
      const before = state.ask;
      const r = callBluff(state);
      expect(r.call).toBe("honest");
      expect(["final", "walk"]).toContain(r.action);
      if (r.action === "final") expect(r.price).toBeGreaterThanOrEqual(before);
      return;
    }
    throw new Error("no honest claim found");
  });

  it("works the same way when the merchant is buying", () => {
    const { state, secret } = untilClaim(3, "buy");
    const claim = state.claim!;
    expect(claim).toBeLessThanOrEqual(secret.floor); // "I can't pay more than X": X ≤ real ceiling
    expect(claim).toBeGreaterThan(state.ask);
    const before = state.ask;
    const r = callBluff(state);
    expect(r.call).toBe(claim < secret.floor ? "caught" : "honest");
    if (r.call === "caught") expect(r.price).toBeGreaterThan(before); // a caught buyer bids up
    expect(r.price).toBeLessThanOrEqual(secret.floor);
  });

  it("calling with no claim on the table is just talk", () => {
    const m = MERCHANTS[0];
    const state = openHaggle(rollSecret(mulberry32(1), m, GOODS[m.goodId]), m.personality);
    expect(callBluff(state)).toEqual(holdReply(state));
    expect(state.round).toBe(0);
  });
});
