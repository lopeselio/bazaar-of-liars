/**
 * Move agents to fresh accounts when their key's gas allowance runs low.
 *
 *   pnpm --filter @bazaar/merchant rekey:agents vesey teahouse deli hotel dowager
 *
 * A function-call key's allowance can't be raised, and agents (by design) have no full-access key
 * to add another, so a busy agent eventually needs a new account. For each id:
 * 1. Create `<id>-<n>.<contract>` (next free n), funded with FUND for gas, with ONE function-call key
 *    for the same methods as before and a larger ALLOWANCE. The key goes to ~/.near-credentials.
 * 2. Call the contract's owner-only `rekey_agent`: the agent's coins, goods, cost basis and memory
 *    move to the new account; its id, orders and history stay.
 * Then it prints the AGENT_ACCOUNTS and AGENT_KEYS values for the hosted server.
 *
 * Pause the market first (hosted MARKET_TICK_MS=0) so no spend authorisation is open on an old account.
 * Signs as the contract account (parent and owner) from the local legacy keychain.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Near, generateKey } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { AGENTS, type AgentDef } from "@bazaar/core";

const FUND = process.env.REKEY_FUND ?? "1 NEAR";
const ALLOWANCE = process.env.REKEY_ALLOWANCE ?? "1 NEAR";
const network = (process.env.NEAR_NETWORK ?? "testnet") as "testnet";
const contract = process.env.BAZAAR_CONTRACT_ID;
if (!contract || !contract.startsWith("v3.")) throw new Error("Set BAZAAR_CONTRACT_ID to the v3 contract");
const ids = process.argv.slice(2);
if (!ids.length) throw new Error("Usage: rekey:agents <agent id>…");
const RPC = "https://rpc.testnet.fastnear.com";
const near = new Near({ network, rpcUrl: RPC, keyStore: new FileKeyStore("~/.near-credentials", network), defaultSignerId: contract });
const credDir = join(homedir(), ".near-credentials", network);
const METHODS = (a: AgentDef) => (a.kind === "customer" ? ["authorize_spend", "pay_agent", "post_order"] : ["authorize_spend", "pay_agent"]);

async function rpc(params: object) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }) }).then((x) => x.json());
  return r.error ? null : r.result;
}
const exists = async (account: string) => !!(await rpc({ request_type: "view_account", finality: "final", account_id: account }));

const moved: Record<string, string> = {};
for (const id of ids) {
  const a = AGENTS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown agent ${id}`);
  let n = 2;
  while (await exists(`${id}-${n}.${contract}`)) n++;
  const account = `${id}-${n}.${contract}`;
  const key = generateKey();
  await near
    .transaction(contract)
    .createAccount(account)
    .transfer(account, FUND as `${number} NEAR`)
    .addKey(key.publicKey.toString(), { type: "functionCall", receiverId: contract, methodNames: METHODS(a), allowance: ALLOWANCE as `${number} NEAR` })
    .send({ waitUntil: "FINAL" });
  mkdirSync(credDir, { recursive: true });
  writeFileSync(join(credDir, `${account}.json`), JSON.stringify({ account_id: account, public_key: key.publicKey.toString(), private_key: key.secretKey }), { mode: 0o600 });
  await near.transaction(contract).functionCall(contract, "rekey_agent", { id, new_account: account }, { gas: "30 Tgas" }).send({ waitUntil: "FINAL" });
  moved[id] = account;
  console.log(`${a.name}: ${id}.${contract} → ${account} (${FUND}, allowance ${ALLOWANCE})`);
}

// Values for the hosted server: every agent's current account, and keys for those accounts.
const accounts: Record<string, string> = JSON.parse(process.env.AGENT_ACCOUNTS || "{}");
Object.assign(accounts, moved);
const keys: Record<string, string> = {};
for (const a of AGENTS) {
  const account = accounts[a.id] ?? `${a.id}.${contract}`;
  try {
    keys[account] = JSON.parse(readFileSync(join(credDir, `${account}.json`), "utf8")).private_key;
  } catch {
    console.warn(`no local key for ${account}`);
  }
}
console.log("\nAGENT_ACCOUNTS=" + JSON.stringify(accounts));
console.log(`AGENT_KEYS: ${Object.keys(keys).length} keys (written to the secret by scripts, never printed)`);
writeFileSync(join(credDir, `agent-keys.${contract}.json`), JSON.stringify(keys), { mode: 0o600 });
console.log(`saved the AGENT_KEYS JSON to ${join(credDir, `agent-keys.${contract}.json`)}`);
