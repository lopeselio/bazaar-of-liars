/**
 * Prints the "Verified" panel for a NEAR AI Cloud model. Free (attestation is non-billable).
 *   pnpm verify:model                 # model from NEARAI_MODEL
 *   pnpm verify:model -- --offline    # skip Intel PCS / NVIDIA NRAS network checks
 *   pnpm verify:model -- --json out.json
 */
import { writeFileSync } from "node:fs";
import { attestModel } from "../attestation.js";

const key = process.env.NEARAI_API_KEY;
const model = process.env.NEARAI_MODEL;
if (!key || !model) {
  console.error("✗ Set NEARAI_API_KEY and NEARAI_MODEL in .env");
  process.exit(1);
}
const offline = process.argv.includes("--offline");
const jsonIdx = process.argv.indexOf("--json");

console.log(`Attesting ${model} with a fresh nonce${offline ? " (offline checks only)" : ""}…\n`);
const { report, verification: v } = await attestModel(model, key, { offline });

v.candidates.forEach((c, i) => {
  console.log(`TEE node ${i + 1}/${v.candidates.length} — signer ${c.signingAddress}`);
  for (const ch of c.checks) {
    const mark = ch.ok ? "✓" : ch.required ? "✗" : "!";
    console.log(`  ${mark} ${ch.label}${ch.detail ? `  (${ch.detail})` : ""}`);
  }
  console.log();
});

console.log(v.ok ? `✓ VERIFIED — trusted signers: ${v.trustedSigners.join(", ")}` : "✗ NOT VERIFIED");
console.log(`  nonce ${v.nonce} · ${v.verifiedAt}`);
if (jsonIdx >= 0) {
  writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ verification: v, report }, null, 2));
  console.log(`  bundle written to ${process.argv[jsonIdx + 1]}`);
}
process.exit(v.ok ? 0 : 1);
