/**
 * `--rpc <url>` for the keyless CLIs (verify:haggle, verify:deed, check:goods): preloaded with
 * `node --import`, before anything reads the RPC list, it puts your endpoint first by prepending
 * it to NEAR_RPC_URL, and takes the flag out of process.argv so the CLI never sees it.
 *   pnpm verify:haggle examples/sample-haggle.json --rpc https://near-testnet.drpc.org
 */
const args = process.argv;
for (let i = 2; i < args.length; i++) {
  const a = args[i]!;
  const url = a === "--rpc" ? args[i + 1] : a.startsWith("--rpc=") ? a.slice(6) : null;
  if (url === null) continue;
  if (!url || !/^https?:\/\//.test(url)) {
    console.error("--rpc needs an http(s) URL, e.g. --rpc https://near-testnet.drpc.org");
    process.exit(2);
  }
  process.env.NEAR_RPC_URL = [url, process.env.NEAR_RPC_URL].filter(Boolean).join(",");
  args.splice(i, a === "--rpc" ? 2 : 1);
  i--;
}
