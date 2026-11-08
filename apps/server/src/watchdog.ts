/**
 * The economy watchdog: every few minutes (wherever the agents act) it reads each agent's gas money
 * and key allowance, the server's and funder's NEAR, and recent street activity; asks the rules in
 * @bazaar/core what's wrong; tops up low agent balances from the funder; and keeps the report for
 * GET /api/health/economy. One replica runs it at a time.
 */
import { assessEconomy, type WatchdogReport } from "@bazaar/core";
import { readAccountGas, sendNear, type Network } from "@bazaar/merchant";
import type { Store } from "./store.js";

export interface WatchdogDeps {
  store: Store;
  network: Network;
  serverId: string;
  funder: { account: string; privateKey?: string } | null;
  agents: () => Promise<{ id: string; kind: string; account: string; coins: number }[]>;
  news: () => Promise<{ t: number; kind: string }[]>;
  log?: (msg: string) => void;
}

const REPORT_KEY = "watchdog:report";

export async function lastReport(store: Store): Promise<(WatchdogReport & { toppedUp?: { account: string; amount: number; tx: string }[] }) | null> {
  return store.getJSON(REPORT_KEY);
}

export async function runWatchdog(d: WatchdogDeps): Promise<WatchdogReport> {
  const log = d.log ?? console.log;
  const prev = await lastReport(d.store);
  const agents = await d.agents();
  const gas = await Promise.all(agents.map(async (a) => ({ ...a, ...(await readAccountGas(d.network, a.account)) })));
  const server = await readAccountGas(d.network, d.serverId);
  const funder = d.funder ? await readAccountGas(d.network, d.funder.account) : null;
  const activity = (await d.news()).filter((n) => n.kind !== "event").map((n) => n.t);
  const report = assessEconomy({
    now: Date.now(),
    agents: gas,
    serverBalance: server.balance,
    funderBalance: funder ? funder.balance : null,
    brokeSince: prev?.brokeSince ?? {},
    activity,
  });
  const toppedUp: { account: string; amount: number; tx: string }[] = [];
  for (const t of report.topUps) {
    try {
      const tx = await sendNear({ network: d.network, from: d.funder!.account, privateKey: d.funder!.privateKey }, t.account, t.amount);
      toppedUp.push({ ...t, tx });
      log(`watchdog: topped up ${t.account} with ${t.amount} NEAR (${tx})`);
    } catch (e) {
      report.checks.push({ level: "alert", subject: t.account, text: `top-up failed: ${(e as Error).message}` });
      report.level = "alert";
    }
  }
  for (const c of report.checks) if (c.level !== "ok") log(`watchdog ${c.level}: ${c.subject}: ${c.text}`);
  await d.store.putJSON(REPORT_KEY, { ...report, toppedUp }, 6 * 3_600_000);
  return report;
}
