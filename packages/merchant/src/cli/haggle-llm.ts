/**
 * Haggle in plain language with a TEE-hosted merchant on NEAR AI Cloud.
 *   pnpm haggle:llm              # random merchant
 *   pnpm haggle:llm -- zaria
 * Type anything ("40, and the stall next door sells it for 35"). Type "leave" to walk.
 * At the end a proof bundle is written to ./haggles/<id>.json — check it with `pnpm verify:haggle <file>`.
 */
import { createInterface } from "node:readline/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { MERCHANTS } from "@bazaar/core";
import { NearAiClient } from "../nearai.js";
import { HaggleSession, nearAiAttestor } from "../session.js";
import { verifyBundle } from "../bundle.js";

const key = process.env.NEARAI_API_KEY;
const model = process.env.NEARAI_MODEL;
if (!key || !model) {
  console.error("✗ Set NEARAI_API_KEY and NEARAI_MODEL in .env");
  process.exit(1);
}
const merchant = MERCHANTS.find((m) => m.id === process.argv.slice(2).find((a) => a !== "--")) ?? MERCHANTS[randomInt(MERCHANTS.length)];
const session = new HaggleSession(new NearAiClient(key), nearAiAttestor(key), model, merchant, randomInt(2 ** 31));

process.stdout.write(`Attesting ${model}… `);
const { commitment, openingAsk, verification } = await session.open();
console.log(`✓ TEE verified (${verification.candidates[0].checks.length} checks)`);
console.log(`\n${merchant.name} sells a ${session.good.name}.`);
console.log(`Secret committed: ${commitment.slice(0, 16)}…`);
console.log(`${merchant.name}: "For you, friend, ${openingAsk} coins."\n`);

// Async-iterating buffers lines, so this works both interactively and with piped input.
const rl = createInterface({ input: process.stdin });
const piped = !process.stdin.isTTY;
process.stdout.write("you> ");
for await (const raw of rl) {
  const text = raw.trim();
  if (!text) {
    process.stdout.write("you> ");
    continue;
  }
  if (piped) console.log(text);
  const t0 = Date.now();
  const r = await session.turn(text);
  if (r.text) console.log(`${merchant.name}: ${r.text}   \x1b[2m(${Date.now() - t0}ms)\x1b[0m`);
  else console.log("You walk away from the stall.");
  if (r.decision?.action === "accept") console.log(`🤝 Deal at ${r.decision.price} coins.`);
  if (r.decision?.action === "walk") console.log(`${merchant.name} has had enough and turns away.`);
  if (session.status !== "open") break;
  process.stdout.write("you> ");
}
rl.close();
if (session.status === "open") console.log("\n(input ended — haggle left open)");

const bundle = await session.bundle();
const dir = `${process.env.INIT_CWD ?? process.cwd()}/haggles`;
mkdirSync(dir, { recursive: true });
const file = `haggles/${bundle.haggleId}.json`;
const fullPath = `${dir}/${bundle.haggleId}.json`;
writeFileSync(fullPath, JSON.stringify(bundle, null, 2));

const { secret } = bundle.reveal;
console.log("\n—— REVEAL ——");
console.log(`Real floor: ${secret.floor} · Need: ${secret.need.replace("_", " ")}`);
if (bundle.outcome.dealPrice !== null) console.log(`You paid ${bundle.outcome.dealPrice}. Left on the table: ${bundle.outcome.leftOnTable} coins.`);
const checks = await verifyBundle(bundle);
const failed = checks.filter((c) => !c.ok);
console.log(failed.length === 0 ? `✓ Fair play verified (${checks.length} checks)` : `✗ ${failed.length} checks failed: ${failed.map((c) => c.label).join("; ")}`);
console.log(`Proof bundle: ${file}  →  pnpm verify:haggle ${file}`);
