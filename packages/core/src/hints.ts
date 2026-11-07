/**
 * Coaching hints after a turn, from what the player can already see: their offer, the price
 * before and after, and the merchant's tell. Never from the secret, so a hint can't leak a floor.
 */
import type { Side, Tell } from "./types.js";

/** Below this share of the gap closed, the merchant "barely moved". */
export const BARELY_MOVED = 0.1;

export interface HintInput {
  /** The merchant's side: "sell" when the player buys. */
  side: Side;
  /** The merchant's price before and after the player's offer. */
  askBefore: number;
  askAfter: number;
  offer: number;
  tell: Tell | null;
  name: string;
}

export function haggleHint(h: HintInput): string | null {
  // Distance from the offer to the price, and how far the merchant came toward it.
  const dir = h.side === "sell" ? 1 : -1;
  const gap = dir * (h.askBefore - h.offer);
  const moved = dir * (h.askBefore - h.askAfter);
  if (gap <= 0) return null;
  const far = gap / Math.max(1, h.askBefore) > 0.3;
  if (h.tell === "irritated" && far)
    return `${h.name} is losing patience. Offers that far off sour the mood, and a merchant remembers a lowball next time. Come closer, or ${h.name} may walk.`;
  if (moved / gap < BARELY_MOVED)
    return `${h.name} barely moved${moved > 0 ? ` (${moved} coin${moved === 1 ? "" : "s"})` : ""}. A price that far off doesn't move a merchant much: offer closer to the ask, or catch a bluff when one comes.`;
  return null;
}
