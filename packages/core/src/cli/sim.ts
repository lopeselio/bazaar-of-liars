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
import { rollBuySecret, rollSellSecret, type Holdings } from "../economy.js";

const short = (name: string) => name.split(" ")[0]!;

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

// ---------- trade loop: buy from the merchant who sells a good, sell it to one who buys it ----------
// Priced by the live game's rules (economy.ts), for a seller with a few on the shelf and a buyer
// holding one: the usual state on Canal Street. A good trader should profit; a careless one shouldn't.
const SELLER: Holdings = { coins: 300, stock: 3, costBasis: 0 };
const BUYER: Holdings = { coins: 300, stock: 1, costBasis: 0 };
console.log(`\nTrade loop — ${SESSIONS * HAGGLES} round trips per route (live pricing; seller has 3, buyer has 1)\n`);
console.log("route".padEnd(44) + "  bought   sold   margin  profitable");
console.log("-".repeat(82));
for (const buyer of MERCHANTS) {
  for (const seller of MERCHANTS.filter((m) => m.goodId === buyer.buysGoodId)) {
    for (const [buyBot, sellBot] of [["sharp", "sellReader"], ["reader", "sellReader"], ["sucker", "sucker"]] as const) {
      const rng = mulberry32(SEED);
      let paid = 0, got = 0, trips = 0, wins = 0;
      for (let i = 0; i < SESSIONS * HAGGLES; i++) {
        const a = playSecret(rollSellSecret(rng, seller, GOODS[seller.goodId]!, SELLER, 1).secret, seller.personality, BOTS[buyBot]!).state;
        const bp = rollBuySecret(rng, buyer, GOODS[buyer.buysGoodId]!, BUYER)!;
        const b = playSecret(bp.secret, buyer.personality, BOTS[sellBot]!).state;
        if (a.status !== "deal" || b.status !== "deal") continue;
        trips++;
        paid += a.dealPrice!;
        got += b.dealPrice!;
        if (b.dealPrice! > a.dealPrice!) wins++;
      }
      console.log(
        `${short(seller.name)} → ${short(buyer.name)} (${buyBot}/${sellBot})`.padEnd(44) +
          (paid / trips).toFixed(0).padStart(8) + (got / trips).toFixed(0).padStart(7) +
          pct(got / paid - 1).padStart(9) + pct(wins / trips).padStart(12),
      );
    }
  }
}
console.log("margin = average sale ÷ average purchase − 1, over round trips where both haggles closed.");
