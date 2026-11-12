/**
 * The economy watchdog's rules. The hosted demo has to keep running unattended through judging,
 * and its agents depend on things that quietly run out: each agent key's gas allowance (fixed
 * when the key is made), each agent account's NEAR (it pays the gas), the server's NEAR, and coins
 * circulating between agents. The server reads those every few minutes; this decides what's wrong
 * and which balances to top up. Pure, so it's tested without a chain.
 */

import { RELIEF_AFTER_MS } from "./relief.js";

export type Level = "ok" | "warn" | "alert";

export interface AgentGas {
  id: string;
  kind: string;
  account: string;
  coins: number;
  /** NEAR the account holds (it pays its own gas). */
  balance: number;
  /** NEAR left in the key's gas allowance; null for an unlimited key or when unknown. */
  allowance: number | null;
}

export interface WatchdogInput {
  now: number;
  agents: AgentGas[];
  /** The game server's own NEAR (it opens and closes every haggle). */
  serverBalance: number;
  /** The funder's NEAR, or null when no funder is configured. */
  funderBalance: number | null;
  /** When each agent was first seen broke (kept between runs). */
  brokeSince: Record<string, number>;
  /** Times of street activity that isn't a scheduled event (trades, restocks, orders…). */
  activity: number[];
  /** Each agent key's allowance when first measured (kept between runs), to project when it runs out. */
  allowanceSeen?: Record<string, AllowanceMark>;
  /** The keys must last until this time (epoch ms): the end of judging. */
  keepUntil?: number;
  /** The contract account: it pays for its own storage, so its free balance must outlast the growth. */
  contract?: { account: string; balance: number; storageBytes: number } | null;
  /** The contract's storage when first measured (kept between runs), for its growth rate. */
  contractSeen?: { at: number; storageBytes: number } | null;
}

/** NEAR per byte of contract storage (10^19 yocto). */
export const STORAGE_NEAR_PER_BYTE = 1e-5;
/** Warn below this much free contract balance; alert below CONTRACT_FREE_ALERT. */
export const CONTRACT_FREE_WARN = 2;
export const CONTRACT_FREE_ALERT = 0.5;

/** An agent key's allowance at a moment, for its burn rate. Reset when the agent moves account. */
export interface AllowanceMark { account: string; at: number; allowance: number }

export interface Check {
  level: Level;
  subject: string;
  text: string;
}

export interface WatchdogReport {
  at: number;
  level: Level;
  checks: Check[];
  /** Agent accounts to top up, and to how much NEAR. */
  topUps: { account: string; amount: number }[];
  brokeSince: Record<string, number>;
  allowanceSeen: Record<string, AllowanceMark>;
  /** Projected day each agent key runs out of allowance (ISO date), where the burn rate is known. */
  runsOut: Record<string, string>;
  /** The contract's free balance over its storage stake, and the projected day it runs out. */
  contractFree?: number;
  contractRunsOut?: string;
  contractSeen?: { at: number; storageBytes: number } | null;
  /** Merchants and traders broke for RELIEF_AFTER_MS: the server asks Auntie Wu to advance them coins. */
  relief: string[];
}

/** The demo must keep running through judging (2026-11-25). */
export const KEEP_UNTIL = Date.UTC(2026, 10, 26);
/** Burn rates need this much history to be worth projecting. */
export const MIN_RATE_WINDOW_MS = 6 * 3_600_000;
/** …and are measured over at most this much (the baseline then moves forward). */
export const RATE_WINDOW_MAX_MS = 3 * 86_400_000;
/** Warn when a key is projected to run out before KEEP_UNTIL; alert inside this much notice. */
export const RUNOUT_ALERT_MS = 2 * 86_400_000;

/** Top an agent account up when it falls below this, back to TOP_UP_TO. Most agents were funded
 * with 0.12 NEAR and burn ~0.001 a day; the busy customers burn ~0.04, so this is a few days' notice
 * for them and never fires for a quiet agent. */
export const LOW_BALANCE = 0.05;
export const TOP_UP_TO = 0.3;
/** Below this much allowance an agent needs `rekey:agents`, which needs the owner key, so the
 * watchdog can only warn. A call reserves its gas at a pessimistic price before it runs, so a key
 * stops working well before its allowance reaches zero: Tobin's key refused every call at 0.031
 * NEAR (11 Nov 2026). Merchants began at 0.1 and burn ~0.001 a day. */
export const LOW_ALLOWANCE = 0.06;
export const CRITICAL_ALLOWANCE = 0.04;
export const SERVER_LOW = 1;
/** A merchant or trader below this many coins counts as broke. */
export const BROKE_COINS = 30;
export const BROKE_TOO_LONG_MS = 3 * 3_600_000;
export const QUIET_TOO_LONG_MS = 60 * 60_000;

/** Kinds whose purse should keep moving; customers, the runner and the cab earn differently. */
const TRADING = new Set(["merchant", "trader", "wholesaler"]);

export function assessEconomy(i: WatchdogInput): WatchdogReport {
  const checks: Check[] = [];
  const topUps: { account: string; amount: number }[] = [];
  const brokeSince: Record<string, number> = {};
  const relief: string[] = [];
  // Keep baselines for agents not measured this run (null allowance, low-allowance branch, a missing read).
  const allowanceSeen: Record<string, AllowanceMark> = { ...(i.allowanceSeen ?? {}) };
  const runsOut: Record<string, string> = {};
  const keepUntil = i.keepUntil ?? KEEP_UNTIL;
  let funds = i.funderBalance ?? 0;

  for (const a of i.agents) {
    if (a.balance < LOW_BALANCE) {
      const amount = Math.round((TOP_UP_TO - a.balance) * 1000) / 1000;
      if (i.funderBalance !== null && funds - amount > 0.05) {
        topUps.push({ account: a.account, amount });
        funds -= amount;
        checks.push({ level: "warn", subject: a.id, text: `${a.balance.toFixed(3)} NEAR left for gas; topping up to ${TOP_UP_TO}` });
      } else {
        checks.push({ level: "alert", subject: a.id, text: `${a.balance.toFixed(3)} NEAR left for gas and no funds to top up` });
      }
    }
    if (a.allowance !== null && a.allowance < LOW_ALLOWANCE) {
      checks.push({ level: a.allowance < CRITICAL_ALLOWANCE ? "alert" : "warn", subject: a.id, text: `key allowance down to ${a.allowance.toFixed(3)} NEAR: run rekey:agents ${a.id}` });
    } else if (a.allowance !== null) {
      // Project from the burn rate since the key was first measured: a busy agent can be far from the
      // fixed floor yet still run dry before judging ends.
      const seen = i.allowanceSeen?.[a.id];
      let mark = seen && seen.account === a.account && seen.allowance >= a.allowance ? seen : { account: a.account, at: i.now, allowance: a.allowance };
      const elapsed = i.now - mark.at;
      const burnt = mark.allowance - a.allowance;
      // Roll the window forward every few days so a burn rate that changes shows up within days.
      if (elapsed > RATE_WINDOW_MAX_MS) mark = { account: a.account, at: i.now, allowance: a.allowance };
      allowanceSeen[a.id] = mark;
      const at = burnt > 1e-6 ? i.now + (a.allowance / burnt) * elapsed : Infinity;
      if (elapsed >= MIN_RATE_WINDOW_MS && Number.isFinite(at) && at < 8.64e15) {
        runsOut[a.id] = new Date(at).toISOString().slice(0, 10);
        if (at < keepUntil) {
          checks.push({ level: at - i.now < RUNOUT_ALERT_MS ? "alert" : "warn", subject: a.id, text: `key allowance (${a.allowance.toFixed(3)} NEAR, ~${((burnt / elapsed) * 86_400_000).toFixed(3)}/day) runs out around ${runsOut[a.id]}, before judging ends: run rekey:agents ${a.id}` });
        }
      }
    }
    if (TRADING.has(a.kind) && a.coins < BROKE_COINS) {
      const since = i.brokeSince[a.id] ?? i.now;
      brokeSince[a.id] = since;
      if ((a.kind === "merchant" || a.kind === "trader") && i.now - since >= RELIEF_AFTER_MS) relief.push(a.id);
      if (i.now - since >= BROKE_TOO_LONG_MS) {
        checks.push({ level: "warn", subject: a.id, text: `broke (${a.coins} coins) for ${Math.round((i.now - since) / 3_600_000)} h` });
      }
    }
  }

  // The contract pays for every haggle's storage; when its free balance is gone, every write fails.
  let contractFree: number | undefined, contractRunsOut: string | undefined;
  let contractSeen = i.contractSeen ?? null;
  if (i.contract) {
    const c = i.contract;
    contractFree = c.balance - c.storageBytes * STORAGE_NEAR_PER_BYTE;
    if (!contractSeen || contractSeen.storageBytes > c.storageBytes || i.now - contractSeen.at > RATE_WINDOW_MAX_MS) contractSeen = { at: i.now, storageBytes: c.storageBytes };
    const elapsed = i.now - contractSeen.at, grown = c.storageBytes - contractSeen.storageBytes;
    if (elapsed >= MIN_RATE_WINDOW_MS && grown > 0) {
      const at = i.now + (contractFree / STORAGE_NEAR_PER_BYTE / grown) * elapsed;
      if (Number.isFinite(at) && at < 8.64e15) {
        contractRunsOut = new Date(at).toISOString().slice(0, 10);
        if (at < keepUntil && contractFree >= CONTRACT_FREE_WARN) {
          checks.push({ level: at - i.now < RUNOUT_ALERT_MS ? "alert" : "warn", subject: "contract", text: `contract storage (~${Math.round(((grown / elapsed) * 86_400_000) / 1000)} KB/day) uses up its ${contractFree.toFixed(2)} free NEAR around ${contractRunsOut}, before judging ends: send NEAR to ${c.account}` });
        }
      }
    }
    if (contractFree < CONTRACT_FREE_WARN) {
      checks.push({ level: contractFree < CONTRACT_FREE_ALERT ? "alert" : "warn", subject: "contract", text: `contract has only ${contractFree.toFixed(3)} NEAR free over its storage stake (~${Math.max(0, Math.round(contractFree / STORAGE_NEAR_PER_BYTE / 1000))} KB): send NEAR to ${c.account}` });
    }
  }

  if (i.serverBalance < SERVER_LOW) checks.push({ level: "alert", subject: "server", text: `server account down to ${i.serverBalance.toFixed(2)} NEAR` });
  if (i.funderBalance !== null && i.funderBalance < 1) checks.push({ level: "warn", subject: "funder", text: `funder down to ${i.funderBalance.toFixed(2)} NEAR` });

  const last = Math.max(0, ...i.activity);
  if (i.now - last > QUIET_TOO_LONG_MS) {
    checks.push({ level: "warn", subject: "street", text: last ? `no trades, restocks or orders for ${Math.round((i.now - last) / 60_000)} min` : "no trades, restocks or orders yet" });
  }

  const level: Level = checks.some((c) => c.level === "alert") ? "alert" : checks.length ? "warn" : "ok";
  return { at: i.now, level, checks, topUps, brokeSince, allowanceSeen, runsOut, contractFree, contractRunsOut, contractSeen, relief };
}
