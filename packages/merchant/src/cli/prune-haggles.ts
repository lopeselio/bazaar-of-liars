/**
 * Free the contract's storage held by settled agent-to-agent haggles (v3.15).
 *
 *   pnpm --filter @bazaar/merchant prune:haggles [--dry-run]
 *
 * Since v3.15 close_haggle doesn't keep an agent's settled haggle. This clears the ones stored
 * before that: it lists every haggle id from the contract's raw storage (no key needed), keeps the
 * agents' ones (the market names them `a-…`), and calls `prune_haggles` in batches, signed by the
 * game server. The contract itself refuses to drop a player's haggle or an open one, whatever ids
 * it's sent, so a player's proof bundle keeps working.
 */
import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { failover, rpcUrls, type Network } from "@bazaar/verify";
import { RPC } from "../reader.js";

const network = (process.env.NEAR_NETWORK ?? "testnet") as Network;
const contract = process.env.BAZAAR_CONTRACT_ID;
const server = process.env.SERVER_ACCOUNT_ID;
if (!contract || !server) throw new Error("Set BAZAAR_CONTRACT_ID and SERVER_ACCOUNT_ID");
const dryRun = process.argv.includes("--dry-run");
const BATCH = 50;

const urls = rpcUrls(network);
const rpcs = failover(urls);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function query(params: object): Promise<any> {
  const r = await rpcs.fetch(urls[0]!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }) });
  const j = (await r.json()) as { result?: unknown; error?: { cause?: { name?: string }; message?: string } };
  if (!j.result) throw new Error(`view_state: ${j.error?.cause?.name ?? j.error?.message ?? r.status}`);
  return j.result;
}

// The haggles map is the contract's first collection (StorageKey::Haggles = 0): key = 0x00, then a
// borsh string (u32 length + bytes). Paged at one block, like check:goods.
const prefix = Buffer.from([0]).toString("base64");
const first = await query({ request_type: "view_state", finality: "final", account_id: contract, prefix_base64: prefix, limit: 1000 });
const keys: string[] = first.values.map((v: { key: string }) => v.key);
for (let after = first.last_key; after; ) {
  const page = await query({ request_type: "view_state", block_id: first.block_height, account_id: contract, prefix_base64: prefix, limit: 1000, after_key_base64: after });
  keys.push(...page.values.map((v: { key: string }) => v.key));
  after = page.last_key;
}
const ids = keys.map((k) => {
  const b = Buffer.from(k, "base64");
  return b.subarray(5, 5 + b.readUInt32LE(1)).toString();
});
const agentIds = ids.filter((id) => id.startsWith("a-"));
console.log(`${ids.length} haggles stored in ${contract}; ${agentIds.length} are agents' (a-…)`);
if (dryRun || !agentIds.length) process.exit(0);

const near = new Near({ network, rpcUrl: RPC[network], keyStore: new FileKeyStore("~/.near-credentials", network), defaultSignerId: server });
let pruned = 0;
for (let i = 0; i < agentIds.length; i += BATCH) {
  const batch = agentIds.slice(i, i + BATCH);
  const r = await near.transaction(server).functionCall(contract, "prune_haggles", { haggle_ids: batch }, { gas: "300 Tgas" }).send({ waitUntil: "FINAL" });
  pruned += batch.length;
  console.log(`  ${pruned}/${agentIds.length} sent (${r.transaction.hash})`);
}
console.log("done: read view_account's storage_usage to see what came back");
