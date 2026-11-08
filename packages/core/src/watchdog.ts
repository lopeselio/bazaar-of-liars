/**
 * The economy watchdog's rules. The hosted demo has to keep running unattended through judging,
 * and its agents depend on things that quietly run out: each agent key's gas allowance (fixed
 * when the key is made), each agent account's NEAR (it pays the gas), the server's NEAR, and coins
 * circulating between agents. The server reads those every few minutes; this decides what's wrong
 * and which balances to top up. Pure, so it's tested without a chain.
 */

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
}

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
}

/** Top an agent account up when it falls below this, back to TOP_UP_TO. */
export const LOW_BALANCE = 0.15;
export const TOP_UP_TO = 0.5;
/** Below this much allowance (about 10 calls) an agent needs `rekey:agents`, which needs the owner
 * key, so the watchdog can only warn. Merchants began at 0.1 and burn ~0.001 a day, so it's well
 * below their starting allowance. */
export const LOW_ALLOWANCE = 0.03;
export const CRITICAL_ALLOWANCE = 0.01;
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
    }
    if (TRADING.has(a.kind) && a.coins < BROKE_COINS) {
      const since = i.brokeSince[a.id] ?? i.now;
      brokeSince[a.id] = since;
      if (i.now - since >= BROKE_TOO_LONG_MS) {
        checks.push({ level: "warn", subject: a.id, text: `broke (${a.coins} coins) for ${Math.round((i.now - since) / 3_600_000)} h` });
      }
    }
  }

  if (i.serverBalance < SERVER_LOW) checks.push({ level: "alert", subject: "server", text: `server account down to ${i.serverBalance.toFixed(2)} NEAR` });
  if (i.funderBalance !== null && i.funderBalance < 1) checks.push({ level: "warn", subject: "funder", text: `funder down to ${i.funderBalance.toFixed(2)} NEAR` });

  const last = Math.max(0, ...i.activity);
  if (i.now - last > QUIET_TOO_LONG_MS) {
    checks.push({ level: "warn", subject: "street", text: last ? `no trades, restocks or orders for ${Math.round((i.now - last) / 60_000)} min` : "no trades, restocks or orders yet" });
  }

  const level: Level = checks.some((c) => c.level === "alert") ? "alert" : checks.length ? "warn" : "ok";
  return { at: i.now, level, checks, topUps, brokeSince };
}
