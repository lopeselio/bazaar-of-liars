import { acceptAsk, callBluff, openHaggle, respond, updateMemory } from "./rules.js";
import { rollSecret } from "./secrets.js";
import { GOODS } from "./catalog.js";
import type { Bot } from "./bots.js";
import type { HaggleState, Merchant, MerchantReply, MerchantSecret, Personality, PlayerMemory, Side } from "./types.js";
import type { Rng } from "./rng.js";

/** Play one full haggle between a scripted bot and a merchant. */
export function playBot(rng: Rng, merchant: Merchant, bot: Bot, memory: PlayerMemory, side: Side = "sell"): HaggleState {
  const good = GOODS[side === "sell" ? merchant.goodId : merchant.buysGoodId];
  const secret = rollSecret(rng, merchant, good, side, memory);
  return playSecret(secret, merchant.personality, bot).state;
}

export interface BotTurn {
  offer: number | "accept" | "call";
  reply: MerchantReply;
}

/**
 * Play a committed secret against a bot: how agents haggle with each other (a trader at a stall,
 * a merchant at the docks). Same rules engine as a player's haggle. With `budget`, the bot never
 * offers or accepts above it, and walks away if the seller's final price is out of reach.
 */
export function playSecret(secret: MerchantSecret, personality: Personality, bot: Bot, budget = Infinity) {
  const state = openHaggle(secret, personality);
  const turns: BotTurn[] = [];
  let lastOffer: number | undefined;
  let reply: MerchantReply | undefined;
  let walked = false;
  for (let guard = 0; guard < 40 && state.status === "open"; guard++) {
    let move = bot({ listPrice: state.ask, round: state.round, lastOffer, reply });
    if (move === "accept" && state.ask > budget) {
      if (reply?.action === "final" || lastOffer === budget) {
        walked = true;
        break;
      }
      move = budget;
    }
    if (typeof move === "number") move = Math.min(move, budget);
    if (move === "accept") reply = acceptAsk(state);
    else if (move === "call") reply = callBluff(state);
    else {
      lastOffer = move;
      reply = respond(state, { price: move });
    }
    turns.push({ offer: move, reply });
  }
  if (state.status === "open" && !walked) throw new Error("haggle did not terminate");
  return { state, turns, walked };
}

export function playSession(rng: Rng, merchant: Merchant, bot: Bot, haggles: number, side: Side = "sell"): HaggleState[] {
  let memory: PlayerMemory = { lowballs: 0, deals: 0 };
  const out: HaggleState[] = [];
  for (let i = 0; i < haggles; i++) {
    const s = playBot(rng, merchant, bot, memory, side);
    memory = updateMemory(memory, s);
    out.push(s);
  }
  return out;
}
