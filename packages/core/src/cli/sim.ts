/**
 * Balance check: pit scripted bots against every merchant, no LLM.
 *   pnpm sim                 # default 300 sessions × 10 haggles per bot/merchant
 *   pnpm sim -- --sessions 50 --seed 7
 */
import { BOTS } from "../bots.js";
import { MERCHANTS } from "../catalog.js";
import { mulberry32 } from "../rng.js";
import { playSession } from "../play.js";

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const SESSIONS = arg("sessions", 300);
const HAGGLES = arg("haggles", 10);
const SEED = arg("seed", 42);

const pct = (x: number) => `${(100 * x).toFixed(0)}%`.padStart(5);

console.log(`Bazaar balance sim — ${SESSIONS} sessions × ${HAGGLES} haggles, seed ${SEED}\n`);
console.log(
  "merchant".padEnd(24) + "bot".padEnd(11) + " deal  walk  overpay  rounds",
);
console.log("-".repeat(64));

for (const merchant of MERCHANTS) {
  for (const [botName, bot] of Object.entries(BOTS)) {
    const rng = mulberry32(SEED);
    let deals = 0, walks = 0, overpay = 0, rounds = 0, n = 0;
    for (let s = 0; s < SESSIONS; s++) {
      for (const h of playSession(rng, merchant, bot, HAGGLES)) {
        n++;
        rounds += h.round;
        if (h.status === "deal") {
          deals++;
          // Share of the haggle range (list → floor) the player gave away. 0% = paid the floor.
          overpay += (h.dealPrice! - h.secret.floor) / Math.max(1, h.secret.listPrice - h.secret.floor);
        } else walks++;
      }
    }
    console.log(
      merchant.name.padEnd(24) +
        botName.padEnd(11) +
        pct(deals / n) + " " + pct(walks / n) + "    " + pct(deals ? overpay / deals : 0) +
        "   " + (rounds / n).toFixed(1).padStart(4),
    );
  }
  console.log();
}
console.log("overpay = share of (list − floor) paid above the secret floor; lower is better haggling.");
