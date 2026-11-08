import { beforeEach, describe, expect, it, vi } from "vitest";

const gas: Record<string, { balance: number; allowance: number | null }> = {};
const sent: { to: string; amount: number }[] = [];
vi.mock("@bazaar/merchant", () => ({
  readAccountGas: async (_n: string, account: string) => gas[account] ?? { balance: 5, allowance: null },
  sendNear: async (_cfg: unknown, to: string, amount: number) => {
    sent.push({ to, amount });
    return "tx123";
  },
}));

const { runWatchdog, lastReport } = await import("../src/watchdog.js");
const { memoryStore } = await import("../src/store.js");

const deps = (store = memoryStore()) => ({
  store,
  network: "testnet" as const,
  serverId: "server.testnet",
  funder: { account: "funds.testnet" },
  agents: async () => [
    { id: "vesey", kind: "customer", account: "vesey-2.v3.x.testnet", coins: 200 },
    { id: "farrukh", kind: "merchant", account: "farrukh.v3.x.testnet", coins: 5 },
  ],
  news: async () => [{ t: Date.now() - 60_000, kind: "trade" }],
  log: () => {},
});

describe("economy watchdog loop", () => {
  beforeEach(() => {
    for (const k of Object.keys(gas)) delete gas[k];
    sent.length = 0;
  });

  it("tops up an agent low on gas from the funder and keeps the report", async () => {
    gas["vesey-2.v3.x.testnet"] = { balance: 0.02, allowance: 0.9 };
    gas["farrukh.v3.x.testnet"] = { balance: 0.3, allowance: 0.09 };
    const d = deps();
    const r = await runWatchdog(d);
    expect(sent).toEqual([{ to: "vesey-2.v3.x.testnet", amount: 0.28 }]);
    const stored = await lastReport(d.store);
    expect(stored?.toppedUp?.[0]).toMatchObject({ account: "vesey-2.v3.x.testnet", tx: "tx123" });
    // Farrukh is broke, but only just: remembered, not yet a warning.
    expect(r.brokeSince.farrukh).toBeGreaterThan(0);
    expect(r.checks.map((c) => c.subject)).toEqual(["vesey"]);
  });

  it("carries 'broke since' from one run to the next", async () => {
    const d = deps();
    const first = await runWatchdog(d);
    const second = await runWatchdog(d);
    expect(second.brokeSince.farrukh).toBe(first.brokeSince.farrukh);
  });
});
