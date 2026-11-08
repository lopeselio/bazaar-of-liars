/**
 * One-time setup of Canal Street's agents on a freshly deployed bazaar contract (v3).
 *
 *   pnpm --filter @bazaar/merchant setup:agents
 *
 * For each agent in packages/core AGENTS:
 * 1. Create `<id>.<contract>` as a sub-account of the contract, funded for gas.
 * 2. Give it ONE key: a function-call key that may only call `authorize_spend` and `pay_agent`
 *    (customers: also `post_order`) on the contract, with a small gas allowance. There is no full-access key, so the agent's key can
 *    never move NEAR or call anything else.
 * 3. Save that key to ~/.near-credentials/<network>/<account>.json (never to the repo).
 * 4. Register the agent with the contract: kind, daily spending cap, opening purse and stock.
 *
 * Signs as the contract account (the parent and owner) from the local legacy keychain.
 * Idempotent: agents whose account already exists are skipped at steps 1–3, and agents already
 * registered (including ones moved by `rekey:agents`) keep the account the contract has for them.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Near, generateKey } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { AGENTS, CUSTOMERS, DAILY_CAP, GOODS, type AgentDef } from "@bazaar/core";
import { readAgentAccounts } from "../chain.js";

const network = (process.env.NEAR_NETWORK ?? "testnet") as "testnet";
const contract = process.env.BAZAAR_CONTRACT_ID;
if (!contract || !contract.startsWith("v3.")) throw new Error("Set BAZAAR_CONTRACT_ID to the v3 contract");
const RPC = "https://rpc.testnet.fastnear.com";
const near = new Near({ network, rpcUrl: RPC, keyStore: new FileKeyStore("~/.near-credentials", network), defaultSignerId: contract });
const credDir = join(homedir(), ".near-credentials", network);

/** Opening purse and stock: (good, units, cost per unit). Merchants start with a modest shelf. */
const OPENING: Record<string, { coins: number; stock: [string, number, number][] }> = {
  farrukh: { coins: 120, stock: [["rug", 4, 30]] },
  zaria: { coins: 150, stock: [["saffron", 4, 20]] },
  tobin: { coins: 100, stock: [["lamp", 5, 12]] },
  wu: { coins: 0, stock: Object.keys(GOODS).map((g) => [g, 300, 0] as [string, number, number]) },
  ivy: { coins: 250, stock: [] },
  rex: { coins: 250, stock: [] },
  lo: { coins: 0, stock: [] },
  ...Object.fromEntries(CUSTOMERS.map((c) => [c.id, { coins: 300, stock: [] as [string, number, number][] }])),
  cab: { coins: 0, stock: [] },
};
const KIND = { merchant: "merchant", wholesaler: "wholesaler", trader: "trader", runner: "runner", customer: "customer", cab: "cab" } as const;
const METHODS = (a: AgentDef) => (a.kind === "customer" ? ["authorize_spend", "pay_agent", "post_order"] : ["authorize_spend", "pay_agent"]);

async function exists(account: string) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }),
  }).then((x) => x.json());
  return !r.error && !!r.result;
}

async function createAgentAccount(a: AgentDef) {
  const account = `${a.id}.${contract}`;
  if (await exists(account)) {
    console.log(`  ${account} exists, skipping`);
    return account;
  }
  const key = generateKey();
  await near
    .transaction(contract!)
    .createAccount(account)
    .transfer(account, "0.12 NEAR")
    .addKey(key.publicKey.toString(), { type: "functionCall", receiverId: contract!, methodNames: METHODS(a), allowance: "0.1 NEAR" })
    .send({ waitUntil: "FINAL" });
  mkdirSync(credDir, { recursive: true });
  const file = join(credDir, `${account}.json`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ account_id: account, public_key: key.publicKey.toString(), private_key: key.secretKey }), { mode: 0o600 });
  console.log(`  created ${account} (function-call key only)`);
  return account;
}

// Agents moved by rekey:agents keep their new account; re-registering only updates name and cap.
const current = await readAgentAccounts(network, contract).catch(() => ({}) as Record<string, string>);
for (const a of AGENTS) {
  console.log(`${a.name} (${a.kind})`);
  const account = current[a.id] ?? (await createAgentAccount(a));
  const open = OPENING[a.id] ?? { coins: 0, stock: [] };
  await near
    .transaction(contract)
    .functionCall(
      contract,
      "register_agent",
      { id: a.id, name: a.name, account, kind: KIND[a.kind], daily_cap: DAILY_CAP[a.kind], coins: open.coins, stock: open.stock },
      { gas: "30 Tgas" },
    )
    .send({ waitUntil: "FINAL" });
  console.log(`  registered: ${open.coins} coins, cap ${DAILY_CAP[a.kind]}/day, stock ${open.stock.map(([g, n]) => `${n} ${g}`).join(", ") || "none"}`);
}
console.log("done");
