import { acceptAsk, callBluff, openHaggle, respond, updateMemory } from "./rules.js";
import { rollSecret } from "./secrets.js";
import { GOODS } from "./catalog.js";
import type { Bot } from "./bots.js";
import type { HaggleState, Merchant, PlayerMemory, Side } from "./types.js";
import type { Rng } from "./rng.js";

/** Play one full haggle between a scripted bot and a merchant. */
export function playBot(rng: Rng, merchant: Merchant, bot: Bot, memory: PlayerMemory, side: Side = "sell"): HaggleState {
  const good = GOODS[side === "sell" ? merchant.goodId : merchant.buysGoodId];
  const secret = rollSecret(rng, merchant, good, side, memory);
  const state = openHaggle(secret, merchant.personality);
  let lastOffer: number | undefined;
  let reply = undefined as ReturnType<typeof respond> | undefined;
  for (let guard = 0; guard < 40 && state.status === "open"; guard++) {
    const move = bot({ listPrice: state.ask, round: state.round, lastOffer, reply });
    if (move === "accept") {
      reply = acceptAsk(state);
    } else if (move === "call") {
      reply = callBluff(state);
    } else {
      lastOffer = move;
      reply = respond(state, { price: move });
    }
  }
  if (state.status === "open") throw new Error("haggle did not terminate");
  return state;
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
