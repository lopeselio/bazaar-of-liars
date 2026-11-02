/**
 * Independently verify a haggle proof bundle. Needs no API key.
 *   pnpm verify:haggle haggles/<id>.json [--online]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyBundle, type ProofBundle } from "../bundle.js";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: pnpm verify:haggle <bundle.json> [--online]");
  process.exit(1);
}
// Paths are relative to where the user ran pnpm (INIT_CWD), not this package.
const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
const bundle = JSON.parse(readFileSync(path, "utf8")) as ProofBundle;
const checks = await verifyBundle(bundle, { online: process.argv.includes("--online") });

console.log(`Haggle ${bundle.haggleId} with ${bundle.merchant.name} (${bundle.model})\n`);
for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? `  (${c.detail})` : ""}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n✗ ${failed} of ${checks.length} checks FAILED` : `\n✓ FAIR PLAY VERIFIED — all ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
