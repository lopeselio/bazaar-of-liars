/**
 * The rumour network: informants around the city sell tips about the next few minutes.
 *
 * A tip is a claim about a merchant's stock at a check time ("Farrukh will have no more than 0
 * lamps at 18:42"), which tells a trader who'll pay top coin or who's about to sell out. The claim
 * itself is chosen here, by rules; the model only puts it in the informant's words. Only its hash
 * goes onchain when it's sold, so nobody else learns it, and the informant can't change it later.
 * At the check time the contract reveals it and checks it against the merchant's real stock. A
 * true tip is paid, a lie is refunded, and every informant's record of truths and lies is public.
 *
 * Some informants lie a lot. Their honesty is hidden; their onchain record is how you learn it.
 *
 * Constants MUST match contracts/bazaar.
 */
import { createHash } from "node:crypto";
import type { Rng } from "./rng.js";

export const TIP_MIN_WAIT_MS = 60_000;
export const TIP_MAX_WAIT_MS = 30 * 60_000;
export const TIP_RESOLVE_WINDOW_MS = 15 * 60_000;
/** How long from buying a tip to its check time. */
export const TIP_HORIZON_MS = 4 * 60_000;
/** How close to an informant the player must be (metres). */
export const INFORMANT_REACH = 40;

export interface Informant {
  id: string;
  name: string;
  where: string;
  /** Slop New York world metres. */
  x: number;
  z: number;
  price: number;
  /** Chance a tip is true when sold. Secret: players learn it from the onchain record. */
  honesty: number;
  voice: string;
}

export const INFORMANTS: Informant[] = [
  { id: "vex", name: "Madame Vex", where: "a doorway off Canal Street", x: 303, z: 4160, price: 12, honesty: 0.45, voice: "a fortune-teller who speaks in riddles and cards" },
  { id: "pete", name: "Pigeon Pete", where: "the corner by the fish market", x: 338, z: 4170, price: 15, honesty: 0.75, voice: "a jittery pigeon-keeper who talks fast and drops names" },
  { id: "deacon", name: "The Deacon", where: "a bench in Bryant Park", x: -295, z: 85, price: 20, honesty: 0.92, voice: "a solemn old man who quotes scripture and never wastes a word" },
  { id: "lulu", name: "Lulu Lightfingers", where: "under the Times Square billboards", x: -569, z: -324, price: 10, honesty: 0.3, voice: "a charming pickpocket who flatters you and winks a lot" },
];
export const informantById = (id: string) => INFORMANTS.find((i) => i.id === id);

export interface TipClaim {
  agent_id: string;
  good_id: string;
  at_most: boolean;
  n: number;
}

/** sha256("bazaar-tip|tip|informant|agent|good|le-or-ge|n|check_ms|salt"). Byte-identical to the contract. */
export function tipCommitment(tipId: string, informant: string, c: TipClaim, checkMs: number, salt: string): string {
  return createHash("sha256")
    .update(`bazaar-tip|${tipId}|${informant}|${c.agent_id}|${c.good_id}|${c.at_most ? "le" : "ge"}|${c.n}|${checkMs}|${salt}`)
    .digest("hex");
}

/** Is the claim true for this stock? (What the contract checks.) */
export const claimHolds = (c: TipClaim, stock: number) => (c.at_most ? stock <= c.n : stock >= c.n);

export interface MerchantStock {
  id: string;
  /** The good it sells, and how many it has. */
  sells: string;
  sellsStock: number;
  /** The good it buys (and uses up), and how many it has. */
  buys: string;
  buysStock: number;
}

/**
 * The claim an informant makes. An honest one says what the merchant's shelves suggest; a lying
 * one says something false right now (so it stays false unless the street changes a lot).
 * Returns the claim and whether it was meant truthfully.
 */
export function makeClaim(rng: Rng, informant: Informant, merchants: MerchantStock[]): { claim: TipClaim; honest: boolean } {
  const m = merchants[Math.floor(rng() * merchants.length)];
  const honest = rng() < informant.honesty;
  const aboutBuys = rng() < 0.55;
  if (aboutBuys) {
    // What it uses up: it rarely gets more on its own, so "no more than now" holds.
    const s = m.buysStock;
    return { honest, claim: honest ? { agent_id: m.id, good_id: m.buys, at_most: true, n: s } : { agent_id: m.id, good_id: m.buys, at_most: false, n: s + 2 } };
  }
  // What it sells: it only goes down (until a restock), so "at least a little less than now" holds.
  const s = m.sellsStock;
  if (honest) return { honest, claim: s <= 1 ? { agent_id: m.id, good_id: m.sells, at_most: true, n: s } : { agent_id: m.id, good_id: m.sells, at_most: false, n: Math.max(0, s - 2) } };
  return { honest, claim: s >= 3 ? { agent_id: m.id, good_id: m.sells, at_most: true, n: Math.max(0, s - 3) } : { agent_id: m.id, good_id: m.sells, at_most: false, n: s + 3 } };
}

/** The claim in plain words, with what it means for a trader. */
export function plainClaim(c: TipClaim, names: { merchant: string; good: string; sells: boolean }): string {
  const amount = c.at_most ? (c.n === 0 ? `no ${names.good} at all` : `no more than ${c.n} ${names.good}`) : `at least ${c.n} ${names.good}`;
  const meaning = names.sells
    ? c.at_most
      ? "selling out: buy now, or sell it to whoever's short"
      : "well stocked: no hurry to buy"
    : c.at_most
      ? "short of it: they'll pay well for one"
      : "well supplied: they won't pay much for more";
  return `${names.merchant} will have ${amount} when the clock runs out. That means they're ${meaning}.`;
}
