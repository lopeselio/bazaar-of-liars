/**
 * Play a haggle in the terminal (no LLM yet — dialogue is templated).
 *   pnpm haggle               # random merchant
 *   pnpm haggle -- zaria      # pick a merchant
 * Input: a number to offer, "45 saw 40" to claim a competitor price, "take" to accept the ask, "quit".
 */
import { createInterface } from "node:readline/promises";
import { randomInt } from "node:crypto";
import { GOODS, MERCHANTS } from "../catalog.js";
import { mulberry32 } from "../rng.js";
import { commit, newSalt, rollSecret, verifyCommitment } from "../secrets.js";
import { acceptAsk, leftOnTable, openHaggle, respond } from "../rules.js";
import type { MerchantReply, Tell } from "../types.js";

const TELL_LINES: Record<Tell, string[]> = {
  relaxed: ["strokes the goods lovingly", "smiles and pours you tea", "hums, unbothered"],
  firm: ["folds their arms", "stops smiling", "taps the counter twice"],
  nervous: ["glances at the street", "fidgets with a ledger", "speaks a little too fast"],
  irritated: ["narrows their eyes", "sighs loudly", "starts wrapping the goods away"],
};

function line(reply: MerchantReply, name: string, pickIdx: number): string {
  const body = TELL_LINES[reply.tell][pickIdx % 3];
  switch (reply.action) {
    case "accept":
      return `${name} ${body}. "Done. ${reply.price} coins."`;
    case "walk":
      return `${name} ${body}. "Enough. Find another stall."`;
    case "final":
      return `${name} ${body}. "${reply.price}. My final price. Take it or leave it."`;
    default: {
      const lie = reply.statedFloor ? ` I cannot go below ${reply.statedFloor}, truly.` : "";
      return `${name} ${body}. "${reply.price}.${lie}"`;
    }
  }
}

const merchant =
  MERCHANTS.find((m) => m.id === process.argv[2]) ?? MERCHANTS[randomInt(MERCHANTS.length)];
const good = GOODS[merchant.goodId];
const rng = mulberry32(randomInt(2 ** 31));
const secret = rollSecret(rng, merchant, good);
const salt = newSalt();
const commitment = commit(secret, salt);
const state = openHaggle(secret, merchant.personality);

console.log(`\n${merchant.name} offers you a ${good.name}.`);
console.log(`Commitment (posted before you speak): ${commitment}`);
console.log(`"For you, friend: ${state.ask} coins."\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
while (state.status === "open") {
  const raw = (await rl.question("> ")).trim().toLowerCase();
  if (raw === "quit") break;
  let reply: MerchantReply;
  if (raw === "take") {
    reply = acceptAsk(state);
  } else {
    const m = raw.match(/^(\d+)(?:\s+saw\s+(\d+))?$/);
    if (!m) {
      console.log('  (enter a number, "45 saw 40", "take", or "quit")');
      continue;
    }
    reply = respond(state, {
      price: Number(m[1]),
      competitorPrice: m[2] ? Number(m[2]) : undefined,
    });
  }
  console.log("  " + line(reply, merchant.name, secret.seed + state.round));
}
rl.close();

console.log("\n—— REVEAL ——");
console.log(`Real floor: ${secret.floor}   Need: ${secret.need}   Salt: ${salt}`);
console.log(`Commitment check: ${verifyCommitment(commitment, secret, salt) ? "✓ fair play verified" : "✗ MISMATCH"}`);
const left = leftOnTable(state);
if (left !== undefined) console.log(`You paid ${state.dealPrice}. Left on the table: ${left} coins.`);
else console.log(state.status === "walked" ? "The merchant walked away." : "You left the stall.");
