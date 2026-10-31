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
    const s = { merchantId: "farrukh", goodId: "rug", floor: 52, need: "rent_due" as const, seed: 7, listPrice: 80 };
    expect(commitmentPreimage(s, "ab")).toBe("bazaar-v1|farrukh|rug|52|rent_due|7|80|ab");
    expect(commit(s, "ab")).toMatch(/^[0-9a-f]{64}$/);
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

  it("remembers lowballers and raises their opening ask", () => {
    const m = MERCHANTS[0];
    const secret = rollSecret(mulberry32(4), m, GOODS[m.goodId]);
    expect(openHaggle(secret, m.personality, { lowballs: 3, deals: 0 }).ask).toBeGreaterThan(
      openHaggle(secret, m.personality).ask,
    );
  });

  it("sessions always terminate for every bot", () => {
    for (const bot of Object.values(BOTS))
      for (const m of MERCHANTS) expect(playSession(mulberry32(11), m, bot, 20)).toHaveLength(20);
  });
});
