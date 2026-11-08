import { randomHex, sha256Hex } from "./hash.js";
import type { Good, Merchant, MerchantSecret, Need, PlayerMemory, Side } from "./types.js";
import { pickWeighted, type Rng } from "./rng.js";

const NEEDS: [Need, number][] = [
  ["rent_due", 2],
  ["restocking", 3],
  ["comfortable", 3],
  ["hoarding", 1],
];

const memoryLevels = (m: PlayerMemory = { lowballs: 0, deals: 0 }) => ({
  grudge: Math.min(5, Math.max(0, m.lowballs)),
  loyalty: Math.min(5, Math.max(0, m.deals)),
});

/**
 * Roll a merchant's hidden hand for one haggle.
 * Selling: floor ~ 0.75–1.05× base value, opening ask well above it.
 * Buying: ceiling ~ 1.05–1.35× base value (about economy.ts with one in stock), so a good
 * bought cheaply at the docks sells at a profit to a merchant who wants it, if you haggle well.
 */
export function rollSecret(rng: Rng, merchant: Merchant, good: Good, side: Side = "sell", memory?: PlayerMemory): MerchantSecret {
  const bluff = merchant.personality.bluff;
  if (side === "sell") {
    const floor = Math.round(good.baseValue * (0.75 + 0.3 * rng()));
    const need = pickWeighted(rng, NEEDS);
    const seed = Math.floor(rng() * 2 ** 31);
    const markup = 1.35 + 0.45 * rng() + 0.2 * bluff;
    return { side, merchantId: merchant.id, goodId: good.id, floor, need, seed, listPrice: Math.round(floor * markup), ...memoryLevels(memory) };
  }
  const ceiling = Math.round(good.baseValue * (1.05 + 0.3 * rng()));
  const need = pickWeighted(rng, NEEDS);
  const seed = Math.floor(rng() * 2 ** 31);
  const opening = 0.7 + 0.15 * rng() - 0.1 * bluff;
  return { side, merchantId: merchant.id, goodId: good.id, floor: ceiling, need, seed, listPrice: Math.max(1, Math.round(ceiling * opening)), ...memoryLevels(memory) };
}

export function newSalt(): string {
  return randomHex(16);
}

/**
 * Canonical preimage. MUST stay byte-identical to the contract's implementation.
 * Pipe-delimited, integers in base 10, salt as lowercase hex.
 */
export function commitmentPreimage(s: MerchantSecret, saltHex: string): string {
  return ["bazaar-v2", s.side, s.merchantId, s.goodId, s.floor, s.need, s.seed, s.listPrice, s.grudge, s.loyalty, saltHex].join("|");
}

/** sha256(preimage) as lowercase hex — posted onchain before the player's first message. */
export function commit(s: MerchantSecret, saltHex: string): string {
  return sha256Hex(commitmentPreimage(s, saltHex));
}

export function verifyCommitment(commitment: string, s: MerchantSecret, saltHex: string): boolean {
  return commit(s, saltHex) === commitment.toLowerCase();
}
