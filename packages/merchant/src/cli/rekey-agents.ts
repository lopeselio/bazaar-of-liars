/**
 * Move agents to fresh accounts when their key's gas allowance runs low.
 *
 *   pnpm --filter @bazaar/merchant rekey:agents vesey teahouse deli hotel dowager
 *
 * A function-call key's allowance can't be raised, and agents (by design) have no full-access key
 * to add another, so a busy agent eventually needs a new account. For each id:
 * 1. Pick `<id>-<n>.<contract>`. A leftover from an earlier run that never got rekeyed (the account
 *    exists, the local key exists, the contract doesn't know it) is reused rather than abandoned.
 * 2. Save a new key to ~/.near-credentials BEFORE creating the account, so a crash can't lose it.
 * 3. Create the account, funded with FUND for gas, with ONE function-call key for the same methods
 *    as before and a larger ALLOWANCE.
 * 4. Call the contract's owner-only `rekey_agent`: coins, goods, cost basis and memory move; the id,
 *    orders and history stay. The contract refuses while the agent has an open authorisation or bid.
 * After each agent, the AGENT_KEYS JSON for every agent's CURRENT account (read from the contract)
 * is saved next to the keychain, so a partial run still leaves the hosted server a correct secret.
 *
 * Signs as the contract account (parent and owner) from the local legacy keychain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Near, generateKey } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { AGENTS, type AgentDef } from "@bazaar/core";
import { readAgentAccounts } from "../chain.js";

const FUND = process.env.REKEY_FUND ?? "0.75 NEAR";
const ALLOWANCE = process.env.REKEY_ALLOWANCE ?? "1 NEAR";
const network = (process.env.NEAR_NETWORK ?? "testnet") as "testnet";
const contract = process.env.BAZAAR_CONTRACT_ID;
if (!contract || !contract.startsWith("v3.")) throw new Error("Set BAZAAR_CONTRACT_ID to the v3 contract");
const ids = process.argv.slice(2);
if (!ids.length) throw new Error("Usage: rekey:agents <agent id>…");
const RPC = "https://rpc.testnet.fastnear.com";
const near = new Near({ network, rpcUrl: RPC, keyStore: new FileKeyStore("~/.near-credentials", network), defaultSignerId: contract });
const credDir = join(homedir(), ".near-credentials", network);
const keyFile = (account: string) => join(credDir, `${account}.json`);
const METHODS = (a: AgentDef) => (a.kind === "customer" ? ["authorize_spend", "pay_agent", "post_order"] : ["authorize_spend", "pay_agent"]);

async function accountState(account: string): Promise<"free" | "exists" | "unknown"> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }),
  }).then((x) => x.json());
  if (r.result) return "exists";
  return r.error?.cause?.name === "UNKNOWN_ACCOUNT" ? "free" : "unknown";
}

/** Save AGENT_KEYS for every agent's current account (as the contract records it). */
async function saveKeys() {
  const current = await readAgentAccounts(network, contract!);
  const keys: Record<string, string> = {};
  for (const a of AGENTS) {
    const account = current[a.id] ?? `${a.id}.${contract}`;
    if (existsSync(keyFile(account))) keys[account] = JSON.parse(readFileSync(keyFile(account), "utf8")).private_key;
    else console.warn(`  no local key for ${account}`);
  }
  const out = join(credDir, `agent-keys.${contract}.json`);
  writeFileSync(out, JSON.stringify(keys), { mode: 0o600 });
  return { current, out };
}

mkdirSync(credDir, { recursive: true });
let failed = 0;
for (const id of ids) {
  const a = AGENTS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown agent ${id}`);
  try {
    const current = await readAgentAccounts(network, contract);
    const old = current[id];
    if (!old) throw new Error("the contract has no such agent");
    const taken = new Set(Object.values(current));
    let account = "";
    for (let n = 2; !account; n++) {
      const candidate = `${id}-${n}.${contract}`;
      if (taken.has(candidate)) continue; // an earlier rekey of this agent
      const st = await accountState(candidate);
      if (st === "unknown") throw new Error(`couldn't check ${candidate}; try again`);
      if (st === "free" || existsSync(keyFile(candidate))) account = candidate;
    }
    if ((await accountState(account)) === "free") {
      const key = generateKey();
      writeFileSync(keyFile(account), JSON.stringify({ account_id: account, public_key: key.publicKey.toString(), private_key: key.secretKey }), { mode: 0o600 });
      await near
        .transaction(contract)
        .createAccount(account)
        .transfer(account, FUND as `${number} NEAR`)
        .addKey(key.publicKey.toString(), { type: "functionCall", receiverId: contract, methodNames: METHODS(a), allowance: ALLOWANCE as `${number} NEAR` })
        .send({ waitUntil: "FINAL" });
      console.log(`${a.name}: created ${account} (${FUND}, allowance ${ALLOWANCE})`);
    } else {
      console.log(`${a.name}: reusing ${account} from an earlier run`);
    }
    await near.transaction(contract).functionCall(contract, "rekey_agent", { id, new_account: account }, { gas: "30 Tgas" }).send({ waitUntil: "FINAL" });
    console.log(`${a.name}: ${old} → ${account}`);
  } catch (e) {
    failed++;
    console.error(`${a.name}: not rekeyed — ${(e as Error).message}`);
  }
  await saveKeys();
}

const { current, out } = await saveKeys();
const moved = Object.fromEntries(Object.entries(current).filter(([id, acct]) => acct !== `${id}.${contract}`));
console.log(`\nAGENT_ACCOUNTS=${JSON.stringify(moved)}  (fallback only; the server reads the contract)`);
console.log(`AGENT_KEYS JSON for the current accounts saved to ${out} (not printed)`);
process.exit(failed ? 1 : 0);
