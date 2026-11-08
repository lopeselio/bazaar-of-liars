import { describe, expect, it } from "vitest";
import { BROKE_TOO_LONG_MS, QUIET_TOO_LONG_MS, TOP_UP_TO, assessEconomy, type AgentGas, type WatchdogInput } from "../src/index.js";

const now = 1_800_000_000_000;
const agent = (over: Partial<AgentGas> = {}): AgentGas => ({ id: "farrukh", kind: "merchant", account: "farrukh.v3.x.testnet", coins: 120, balance: 0.4, allowance: 0.5, ...over });
const base = (over: Partial<WatchdogInput> = {}): WatchdogInput => ({ now, agents: [agent()], serverBalance: 4, funderBalance: 4, brokeSince: {}, activity: [now - 60_000], ...over });

describe("economy watchdog", () => {
  it("is quiet when everything is healthy", () => {
    const r = assessEconomy(base());
    expect(r.level).toBe("ok");
    expect(r.checks).toEqual([]);
    expect(r.topUps).toEqual([]);
  });

  it("tops up an agent low on gas money from the funder", () => {
    const r = assessEconomy(base({ agents: [agent({ balance: 0.03 })] }));
    expect(r.topUps).toEqual([{ account: "farrukh.v3.x.testnet", amount: TOP_UP_TO - 0.03 }]);
    // A quiet agent still on its 0.12 NEAR opening balance needs nothing.
    expect(assessEconomy(base({ agents: [agent({ balance: 0.12 })] })).level).toBe("ok");
    expect(r.level).toBe("warn");
  });

  it("alerts instead when there is no funder or it can't cover the top-up", () => {
    expect(assessEconomy(base({ agents: [agent({ balance: 0.03 })], funderBalance: null })).level).toBe("alert");
    const r = assessEconomy(base({ agents: [agent({ balance: 0.03 })], funderBalance: 0.2 }));
    expect(r.topUps).toEqual([]);
    expect(r.level).toBe("alert");
  });

  it("never promises more top-ups than the funder holds", () => {
    const agents = ["a", "b", "c"].map((id) => agent({ id, account: `${id}.x`, balance: 0 }));
    const r = assessEconomy(base({ agents, funderBalance: 0.7 }));
    expect(r.topUps).toHaveLength(2);
    expect(r.topUps.reduce((s, t) => s + t.amount, 0)).toBeLessThanOrEqual(0.65);
  });

  it("asks for a rekey when a key's allowance runs low", () => {
    const r = assessEconomy(base({ agents: [agent({ allowance: 0.02 })] }));
    expect(r.checks[0].text).toContain("rekey:agents farrukh");
    expect(assessEconomy(base({ agents: [agent({ allowance: 0.005 })] })).level).toBe("alert");
    // A merchant still near its original 0.1 NEAR allowance is fine.
    expect(assessEconomy(base({ agents: [agent({ allowance: 0.0987 })] })).level).toBe("ok");
    expect(assessEconomy(base({ agents: [agent({ allowance: null })] })).level).toBe("ok");
  });

  it("remembers when a merchant went broke and warns after hours, not minutes", () => {
    const poor = agent({ coins: 5 });
    const first = assessEconomy(base({ agents: [poor] }));
    expect(first.brokeSince.farrukh).toBe(now);
    expect(first.level).toBe("ok");
    const later = assessEconomy(base({ agents: [poor], brokeSince: first.brokeSince, now: now + BROKE_TOO_LONG_MS }));
    expect(later.checks.map((c) => c.subject)).toContain("farrukh");
    // Recovered: forgotten.
    expect(assessEconomy(base({ brokeSince: first.brokeSince })).brokeSince).toEqual({});
  });

  it("ignores customers' purses (they earn through income, not trade)", () => {
    expect(assessEconomy(base({ agents: [agent({ kind: "customer", coins: 0 })] })).brokeSince).toEqual({});
  });

  it("warns when the street has been quiet too long, and when the server runs low", () => {
    expect(assessEconomy(base({ activity: [now - QUIET_TOO_LONG_MS - 1] })).checks[0].subject).toBe("street");
    expect(assessEconomy(base({ serverBalance: 0.5 })).level).toBe("alert");
  });
});
