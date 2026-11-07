// Checks that the bazaar contract's goods add up: for each NEP-245 token, the sum of every
// balance in the contract's storage (players, agents, and the contract's own escrow) must equal
// mt_supply. Reads raw state over RPC; needs no key.
//   node scripts/check-goods.mjs [contract]
const contract = process.argv[2] ?? process.env.BAZAAR_CONTRACT_ID ?? "v3.bazaar-liars.testnet";
const RPC = "https://rpc.testnet.fastnear.com";
const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json());
  if (r.error) {
    console.error(`✗ ${method}: ${r.error.cause?.name ?? r.error.message}`);
    process.exit(2);
  }
  return r.result;
};
// The goods ledger is the contract's third storage collection (StorageKey::Goods = 2).
// Read page by page at one block: a node refuses to list the whole state at once past 50 kB
// (TOO_LARGE_CONTRACT_STATE), and every read below uses that same block.
const prefix = Buffer.from([2]).toString("base64");
const first = await rpc("query", { request_type: "view_state", finality: "final", account_id: contract, prefix_base64: prefix, limit: 200 });
const state = { block_height: first.block_height, values: [...first.values] };
for (let after = first.last_key; after; ) {
  const page = await rpc("query", { request_type: "view_state", block_id: state.block_height, account_id: contract, prefix_base64: prefix, limit: 200, after_key_base64: after });
  state.values.push(...page.values);
  after = page.last_key;
}
const sums = {};
let holders = 0;
for (const { key, value } of state.values) {
  const k = Buffer.from(key, "base64");
  const name = k.subarray(5, 5 + k.readUInt32LE(1)).toString();
  const good = name.slice(name.lastIndexOf("#") + 1);
  sums[good] = (sums[good] ?? 0) + Buffer.from(value, "base64").readUInt32LE(0);
  holders++;
}
const view = async (method, args) => {
  const r = await rpc("query", { request_type: "call_function", block_id: state.block_height, account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
};
let ok = true;
for (const good of Object.keys(sums).sort()) {
  const supply = Number(await view("mt_supply", { token_id: good }));
  const match = supply === sums[good];
  ok &&= match;
  console.log(`${match ? "✓" : "✗"} ${good}: ${sums[good]} held across balances, mt_supply ${supply}`);
}
console.log(`${holders} balances read from ${contract} at block ${state.block_height}`);
process.exit(ok ? 0 : 1);
