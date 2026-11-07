/**
 * Balance check: pit scripted bots against every merchant, no LLM.
 *   pnpm sim                 # default 300 sessions × 10 haggles per bot/merchant
 *   pnpm sim -- --sessions 50 --seed 7
 */
import { BOTS } from "../bots.js";
import { MERCHANTS } from "../catalog.js";
import { mulberry32 } from "../rng.js";
import { playSecret, playSession } from "../play.js";
import { GOODS } from "../catalog.js";
import { rollBuySecret, type Holdings } from "../economy.js";
import { askPrice } from "../routes.js";

const short = (name: string) => name.replace(/^Old /, "").split(" ")[0]!;

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

// ---------- trade loop: buy a good at Auntie Wu's board, sell it to the merchant who wants it ----------
// Priced by the live game's rules (economy.ts, routes.ts): Wu with a well-stocked board, a buyer
// holding one. A careless trader should about break even; a good haggler should profit.
const BUYER: Holdings = { coins: 300, stock: 1, costBasis: 0 };
console.log(`\nTrade loop — ${SESSIONS * HAGGLES} trips per route (Wu's board, then a merchant who holds one)\n`);
console.log("route".padEnd(40) + "  bought   sold   margin  profitable");
console.log("-".repeat(78));
for (const buyer of MERCHANTS) {
  const good = GOODS[buyer.buysGoodId]!;
  const wu = askPrice(good.baseValue, 8, 0)!;
  for (const sellBot of ["sellReader", "seller", "sucker"] as const) {
    const rng = mulberry32(SEED);
    let got = 0, trips = 0, wins = 0;
    for (let i = 0; i < SESSIONS * HAGGLES; i++) {
      const b = playSecret(rollBuySecret(rng, buyer, good, BUYER)!.secret, buyer.personality, BOTS[sellBot]!).state;
      if (b.status !== "deal") continue;
      trips++;
      got += b.dealPrice!;
      if (b.dealPrice! > wu) wins++;
    }
    console.log(
      `Wu → ${short(buyer.name)}, ${good.id} (${sellBot})`.padEnd(40) +
        String(wu).padStart(8) + (got / trips).toFixed(0).padStart(7) +
        pct(got / trips / wu - 1).padStart(9) + pct(wins / trips).padStart(12),
    );
  }
}
console.log("margin = average sale ÷ Wu's price − 1, over sales that closed.");
