/**
 * Scripted player strategies for balance testing (no LLM).
 * Balance goal: reading tells ("reader") should beat naive strategies, and lowballing
 * should be risky — more walkaways and grudges — not a dominant shortcut.
 */
import type { MerchantReply, Tell } from "./types.js";

export interface BotView {
  listPrice: number;
  round: number;
  lastOffer: number | undefined;
  reply: MerchantReply | undefined;
}

/** Return a price to offer, "accept" to take the current ask, or "call" to call a claimed limit. */
export type Bot = (v: BotView) => number | "accept" | "call";

const ask = (v: BotView) => v.reply?.price ?? v.listPrice;

export const BOTS: Record<string, Bot> = {
  /** Opens at half and inches up. */
  lowballer: (v) => {
    if (v.reply?.action === "final") return "accept";
    return Math.round(v.listPrice * (0.45 + 0.05 * v.round));
  },
  /** Opens at 60% and splits the difference each round. */
  splitter: (v) => {
    if (v.reply?.action === "final") return "accept";
    if (v.lastOffer === undefined) return Math.round(v.listPrice * 0.6);
    return Math.round((v.lastOffer + ask(v)) / 2);
  },
  /** Pays list. A baseline: never haggles. */
  sucker: () => "accept",
  /** Calls every claim, otherwise splits. Naive: honest merchants punish it. */
  caller: (v) => {
    if (v.reply?.action === "final") return "accept";
    if (v.reply?.statedFloor !== undefined && v.reply.call === undefined) return "call";
    if (v.lastOffer === undefined) return Math.round(v.listPrice * 0.6);
    return Math.round((v.lastOffer + ask(v)) / 2);
  },
  /** Calls claims only when the merchant doesn't look close to its limit (not "firm"). */
  sharp: (v) => {
    if (v.reply?.action === "final") return "accept";
    if (v.reply?.statedFloor !== undefined && v.reply.call === undefined && v.reply.tell !== "firm") return "call";
    if (v.lastOffer === undefined) return Math.round(v.listPrice * 0.6);
    return Math.round((v.lastOffer + ask(v)) / 2);
  },
  /** Reacts to tells: pushes while relaxed, backs off when firm/irritated, presses when nervous. */
  reader: (v) => {
    if (v.reply?.action === "final") return "accept";
    const last = v.lastOffer ?? Math.round(v.listPrice * 0.55);
    if (v.lastOffer === undefined) return last;
    const a = ask(v);
    const tell: Tell = v.reply?.tell ?? "relaxed";
    switch (tell) {
      case "firm":
        return Math.round(a - (a - last) * 0.15); // near floor — close it
      case "irritated":
        return Math.round(last + (a - last) * 0.6); // repair the mood
      case "nervous":
        return Math.round(last + (a - last) * 0.12); // they need the sale — hold low
      default:
        return Math.round(last + (a - last) * 0.25);
    }
  },
};
