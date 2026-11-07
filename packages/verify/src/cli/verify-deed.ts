/**
 * pnpm verify:deed corner-1
 *
 * Reads a stall deed's Ethereum certificate from the bazaar contract, derives the bazaar's
 * Ethereum address from NEAR's MPC signer, and checks the signature with Ethereum's own rules.
 * No keys, no game server.
 */
import { verifyDeedOnchain } from "../deeds.js";

const slot = process.argv[2] ?? "corner-1";
const network = process.env.NEAR_NETWORK ?? "testnet";
const contractId = process.env.BAZAAR_CONTRACT_ID ?? "v3.bazaar-liars.testnet";

const r = await verifyDeedOnchain(network, contractId, slot);
console.log(`Deed ${slot} on ${contractId} (${network})`);
console.log(`Bazaar's Ethereum address: ${r.ethAddress}`);
console.log(`  derived by ${r.signer} from (${contractId}, "${r.path}")`);
if (!r.cert) {
  console.log("No certificate yet. The deed's owner can ask for one from the stall panel (🔗 Certify on Ethereum).");
  process.exit(1);
}
console.log(`\n"${r.cert.message}"\nsignature ${r.cert.signature}\n`);
for (const c of r.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.label}\n    ${c.detail}`);
const ok = r.checks.every((c) => c.ok);
console.log(ok ? "\n✓ Certificate verified: any EVM chain's ecrecover gives the same address." : "\n✗ Not verified (see above).");
process.exit(ok ? 0 : 1);
