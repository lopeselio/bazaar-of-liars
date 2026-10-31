import { createHash, randomBytes } from "node:crypto";
import type { Good, Merchant, MerchantSecret, Need } from "./types.js";
import { pickWeighted, type Rng } from "./rng.js";

const NEEDS: [Need, number][] = [
  ["rent_due", 2],
  ["restocking", 3],
  ["comfortable", 3],
  ["hoarding", 1],
];

/** Roll a merchant's hidden hand for one haggle. */
export function rollSecret(rng: Rng, merchant: Merchant, good: Good): MerchantSecret {
  const floor = Math.round(good.baseValue * (0.75 + 0.3 * rng()));
  const need = pickWeighted(rng, NEEDS);
  const seed = Math.floor(rng() * 2 ** 31);
  const markup = 1.35 + 0.45 * rng() + 0.2 * merchant.personality.bluff;
  return {
    merchantId: merchant.id,
    goodId: good.id,
    floor,
    need,
    seed,
    listPrice: Math.round(floor * markup),
  };
}

export function newSalt(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Canonical preimage. MUST stay byte-identical to the contract's implementation.
 * Pipe-delimited, integers in base 10, salt as lowercase hex.
 */
export function commitmentPreimage(s: MerchantSecret, saltHex: string): string {
  return ["bazaar-v1", s.merchantId, s.goodId, s.floor, s.need, s.seed, s.listPrice, saltHex].join("|");
}

/** sha256(preimage) as lowercase hex — posted onchain before the player's first message. */
export function commit(s: MerchantSecret, saltHex: string): string {
  return createHash("sha256").update(commitmentPreimage(s, saltHex), "utf8").digest("hex");
}

export function verifyCommitment(commitment: string, s: MerchantSecret, saltHex: string): boolean {
  return commit(s, saltHex) === commitment.toLowerCase();
}
