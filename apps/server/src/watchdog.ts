/**
 * The economy watchdog: every few minutes (wherever the agents act) it reads each agent's gas money
 * and key allowance, the server's and funder's NEAR, and recent street activity; asks the rules in
 * @bazaar/core what's wrong; tops up low agent balances from the funder; has Auntie Wu advance
 * coins to merchants and traders broke for hours (signed with her key); and keeps the report for
 * GET /api/health/economy. One replica runs it at a time.
 */
import { assessEconomy, type WatchdogReport } from "@bazaar/core";
import { readAccountGas, sendNear, type Network } from "@bazaar/merchant";
import type { Store } from "./store.js";

export interface WatchdogDeps {
  store: Store;
  network: Network;
  serverId: string;
  /** The game contract (it pays for its own storage). */
  contractId?: string;
  funder: { account: string; privateKey?: string } | null;
  agents: () => Promise<{ id: string; kind: string; account: string; coins: number }[]>;
  news: () => Promise<{ t: number; kind: string }[]>;
  /** Auntie Wu advances coins to agents broke too long (the market signs it); returns what she paid. */
  relieve?: (ids: string[]) => Promise<{ id: string; amount: number; tx: string }[]>;
  log?: (msg: string) => void;
}

const REPORT_KEY = "watchdog:report";
/** Allowance baselines outlive the report (burn rates need days of history). */
const SEEN_KEY = "watchdog:allowance";
const CONTRACT_SEEN_KEY = "watchdog:contract";

export async function lastReport(store: Store): Promise<(WatchdogReport & { toppedUp?: { account: string; amount: number; tx: string }[]; relieved?: { id: string; amount: number; tx: string }[] }) | null> {
  return store.getJSON(REPORT_KEY);
}

export async function runWatchdog(d: WatchdogDeps): Promise<WatchdogReport> {
  const log = d.log ?? console.log;
  const prev = await lastReport(d.store);
  const agents = await d.agents();
  const gas = await Promise.all(agents.map(async (a) => ({ ...a, ...(await readAccountGas(d.network, a.account)) })));
  const server = await readAccountGas(d.network, d.serverId);
  const funder = d.funder ? await readAccountGas(d.network, d.funder.account) : null;
  const contract = d.contractId ? { account: d.contractId, ...(await readAccountGas(d.network, d.contractId)) } : null;
  const activity = (await d.news()).filter((n) => n.kind !== "event").map((n) => n.t);
  const report = assessEconomy({
    now: Date.now(),
    agents: gas,
    serverBalance: server.balance,
    funderBalance: funder ? funder.balance : null,
    brokeSince: prev?.brokeSince ?? {},
    activity,
    allowanceSeen: (await d.store.getJSON(SEEN_KEY)) ?? {},
    contract,
    contractSeen: await d.store.getJSON(CONTRACT_SEEN_KEY),
  });
  await d.store.putJSON(SEEN_KEY, report.allowanceSeen, 30 * 86_400_000);
  if (report.contractSeen) await d.store.putJSON(CONTRACT_SEEN_KEY, report.contractSeen, 30 * 86_400_000);
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
  // The watchdog acts on broke agents too, not just reports them.
  let relieved: { id: string; amount: number; tx: string }[] = [];
  if (d.relieve && report.relief.length) {
    try {
      relieved = await d.relieve(report.relief);
      for (const r of relieved) log(`watchdog: Auntie Wu advanced ${r.id} ${r.amount} coins (${r.tx})`);
    } catch (e) {
      report.checks.push({ level: "warn", subject: "relief", text: `advance failed: ${(e as Error).message}` });
      if (report.level === "ok") report.level = "warn";
    }
  }
  for (const c of report.checks) if (c.level !== "ok") log(`watchdog ${c.level}: ${c.subject}: ${c.text}`);
  await d.store.putJSON(REPORT_KEY, { ...report, toppedUp, relieved }, 6 * 3_600_000);
  return report;
}
