/**
 * One barter between two agents, settled through the NEAR Intents Verifier on testnet.
 *
 *   pnpm --filter @bazaar/merchant intents:barter farrukh:rug:1 wu:lamp:2
 *
 * Each side gives the good it names; each receives what the other gives. Both goods are deposited
 * into the Verifier for the agents' own identities, both agents sign token_diff + mt_withdraw
 * intents with their own keys, the batch is simulated, then executed (the server relays).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { barterIntents, readSalt, simulateIntents } from "../intents.js";
import { ledgerFromEnv, readAgentAccounts, readAgents, explorerTx } from "../chain.js";

const VERIFIER = process.env.INTENTS_VERIFIER ?? "bazaar-intents.testnet";
const [a, b] = process.argv.slice(2).map((s) => {
  const [id, good, qty] = s.split(":");
  return { id: id!, good: good!, qty: Number(qty) };
});
if (!a || !b) throw new Error("Usage: intents:barter <agent>:<good>:<qty> <agent>:<good>:<qty>");
const ledger = ledgerFromEnv();
if (!ledger?.intentsDeposit || !ledger.executeIntents) throw new Error("set BAZAAR_CONTRACT_ID and SERVER_ACCOUNT_ID");
const network = ledger.network;
const accounts = await readAgentAccounts(network, ledger.contractId);
const keys: Record<string, string> = JSON.parse(readFileSync(join(homedir(), ".near-credentials", network, `agent-keys.${ledger.contractId}.json`), "utf8"));
const goods = ["rug", "saffron", "lamp"];
const stock = async () => Object.fromEntries((await readAgents(network, ledger.contractId, goods)).filter((x) => x.id === a.id || x.id === b.id).map((x) => [x.id, x.goods]));

console.log("before:", await stock());
for (const s of [a, b]) {
  const tx = await ledger.intentsDeposit({ agentId: s.id, goodId: s.good, qty: s.qty });
  console.log(`deposited ${s.qty} ${s.good} for ${s.id}: ${explorerTx(network, tx)}`);
}
const side = (me: typeof a, them: typeof a) => ({ agentAccount: accounts[me.id]!, privateKey: keys[accounts[me.id]!]!, give: { good: me.good, qty: me.qty }, get: { good: them.good, qty: them.qty } });
const signed = barterIntents({ gameContract: ledger.contractId, verifier: VERIFIER, saltHex: await readSalt(network, VERIFIER), a: side(a, b), b: side(b, a), memo: "bazaar barter" });
await simulateIntents(network, VERIFIER, signed);
console.log("simulation passed");
const tx = await ledger.executeIntents(VERIFIER, signed);
console.log(`settled through NEAR Intents: ${explorerTx(network, tx)}`);
console.log("after:", await stock());
