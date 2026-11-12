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
    // A key stops working before it reaches zero: Tobin's refused every call at 0.031.
    expect(assessEconomy(base({ agents: [agent({ allowance: 0.031 })] })).level).toBe("alert");
    expect(assessEconomy(base({ agents: [agent({ allowance: 0.05 })] })).checks[0].text).toContain("rekey:agents farrukh");
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
    expect(later.relief).toEqual(["farrukh"]); // broke past RELIEF_AFTER_MS: Wu is asked to step in
    expect(first.relief).toEqual([]);
    expect(assessEconomy(base({ agents: [agent({ kind: "wholesaler", coins: 5 })], brokeSince: { farrukh: now - BROKE_TOO_LONG_MS } })).relief).toEqual([]);
    // Recovered: forgotten.
    expect(assessEconomy(base({ brokeSince: first.brokeSince })).brokeSince).toEqual({});
  });

  it("treats a merchant that can't afford a lot like a broke one", () => {
    const stuck = agent({ coins: 41, stuck: true });
    const first = assessEconomy(base({ agents: [stuck] }));
    const later = assessEconomy(base({ agents: [stuck], brokeSince: first.brokeSince, now: now + BROKE_TOO_LONG_MS }));
    expect(later.relief).toEqual(["farrukh"]);
    expect(later.checks.find((c) => c.subject === "farrukh")?.text).toContain("can't afford a lot");
  });

  it("ignores customers' purses (they earn through income, not trade)", () => {
    expect(assessEconomy(base({ agents: [agent({ kind: "customer", coins: 0 })] })).brokeSince).toEqual({});
  });

  it("warns when the street has been quiet too long, and when the server runs low", () => {
    expect(assessEconomy(base({ activity: [now - QUIET_TOO_LONG_MS - 1] })).checks[0].subject).toBe("street");
    expect(assessEconomy(base({ serverBalance: 0.5 })).level).toBe("alert");
  });

  describe("projected allowance run-out", () => {
    const H = 3_600_000, D = 24 * H;
    const keepUntil = now + 16 * D;
    it("records a baseline on first sight and projects once there's enough history", () => {
      const first = assessEconomy(base({ keepUntil, agents: [agent({ id: "vesey", allowance: 1 })] }));
      expect(first.allowanceSeen.vesey).toEqual({ account: "farrukh.v3.x.testnet", at: now, allowance: 1 });
      expect(first.checks).toEqual([]);
      // 15 h later 0.18 is gone: ~0.29/day, so 0.82 lasts ~2.8 days, well before judging ends.
      const later = assessEconomy(base({ now: now + 15 * H, activity: [now + 15 * H - 60_000], keepUntil, allowanceSeen: first.allowanceSeen, agents: [agent({ id: "vesey", allowance: 0.82 })] }));
      const c = later.checks.find((x) => x.subject === "vesey")!;
      expect(c.level).toBe("warn");
      expect(c.text).toMatch(/runs out around .* before judging ends: run rekey:agents vesey/);
      expect(later.runsOut.vesey).toBeDefined();
    });
    it("alerts when the run-out is under two days away", () => {
      const seen = { vesey: { account: "farrukh.v3.x.testnet", at: now - 10 * H, allowance: 0.5 } };
      const r = assessEconomy(base({ keepUntil, allowanceSeen: seen, agents: [agent({ id: "vesey", allowance: 0.3 })] }));
      expect(r.checks.find((x) => x.subject === "vesey")!.level).toBe("alert");
    });
    it("is quiet for a slow burner that lasts past judging", () => {
      const seen = { farrukh: { account: "farrukh.v3.x.testnet", at: now - 2 * D, allowance: 0.5 } };
      const r = assessEconomy(base({ keepUntil, allowanceSeen: seen, agents: [agent({ allowance: 0.498 })] }));
      expect(r.checks).toEqual([]);
      expect(r.runsOut.farrukh > new Date(keepUntil).toISOString().slice(0, 10)).toBe(true);
    });
    it("starts over after a rekey (new account, or the allowance went up)", () => {
      const seen = { vesey: { account: "vesey-2.v3.x.testnet", at: now - 2 * D, allowance: 1 } };
      const r = assessEconomy(base({ keepUntil, allowanceSeen: seen, agents: [agent({ id: "vesey", account: "vesey-3.v3.x.testnet", allowance: 5 })] }));
      expect(r.allowanceSeen.vesey).toEqual({ account: "vesey-3.v3.x.testnet", at: now, allowance: 5 });
      expect(r.checks).toEqual([]);
    });
    it("review: float-noise burn never crashes the run (no Invalid time value)", () => {
      const seen = { farrukh: { account: "farrukh.v3.x.testnet", at: now - 7 * H, allowance: 0.5 + 1e-15 } };
      expect(() => assessEconomy(base({ keepUntil, allowanceSeen: seen, agents: [agent({ allowance: 0.5 })] }))).not.toThrow();
      const tiny = { farrukh: { account: "farrukh.v3.x.testnet", at: now - 7 * H, allowance: 0.5 + 1e-9 } };
      expect(assessEconomy(base({ keepUntil, allowanceSeen: tiny, agents: [agent({ allowance: 0.5 })] })).runsOut.farrukh).toBeUndefined();
    });
    it("review: keeps baselines for agents not measured this run", () => {
      const seen = { rex: { account: "rex.v3.x.testnet", at: now - D, allowance: 0.1 } };
      const r = assessEconomy(base({ keepUntil, allowanceSeen: seen, agents: [agent({ allowance: null })] }));
      expect(r.allowanceSeen.rex).toEqual(seen.rex);
    });
    it("review: the rate window rolls forward after a few days", () => {
      const seen = { farrukh: { account: "farrukh.v3.x.testnet", at: now - 4 * D, allowance: 0.5 } };
      const r = assessEconomy(base({ keepUntil, allowanceSeen: seen, agents: [agent({ allowance: 0.49 })] }));
      expect(r.allowanceSeen.farrukh).toEqual({ account: "farrukh.v3.x.testnet", at: now, allowance: 0.49 });
    });
  });

  describe("contract storage", () => {
    const H = 3_600_000, D = 24 * H;
    const keepUntil = now + 16 * D;
    const contract = (balance: number, storageBytes: number) => ({ account: "v3.x.testnet", balance, storageBytes });
    it("alerts on the state found in the audit (0.27 NEAR, ~27 KB free)", () => {
      const r = assessEconomy(base({ keepUntil, contract: contract(7.9817, 771_555) }));
      const c = r.checks.find((x) => x.subject === "contract")!;
      expect(c.level).toBe("alert");
      expect(c.text).toMatch(/only 0\.266 NEAR free .*~27 KB.*send NEAR to v3\.x\.testnet/);
    });
    it("projects the run-out from storage growth and warns before judging ends", () => {
      // 8.26 NEAR free, growing ~100 KB/day: about 8 days, before keepUntil (16 days).
      const seen = { at: now - 12 * H, storageBytes: 771_555 - 50_000 };
      const r = assessEconomy(base({ keepUntil, contract: contract(15.98, 771_555), contractSeen: seen }));
      expect(r.contractFree).toBeCloseTo(8.27, 1);
      const c = r.checks.find((x) => x.subject === "contract")!;
      expect(c.level).toBe("warn");
      expect(c.text).toMatch(/~100 KB\/day.*before judging ends/);
      expect(r.contractSeen).toEqual(seen);
    });
    it("is quiet when the balance outlasts the growth", () => {
      const r = assessEconomy(base({ keepUntil, contract: contract(40, 771_555), contractSeen: { at: now - 12 * H, storageBytes: 771_555 - 50_000 } }));
      expect(r.checks.filter((x) => x.subject === "contract")).toEqual([]);
    });
  });
});

