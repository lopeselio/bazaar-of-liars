/**
 * The merchant rules engine — the ONLY thing that decides accept / counter / walk.
 * The LLM layer writes dialogue around these decisions; it can never override them.
 *
 * Invariant (tested): a merchant never accepts, counters, or settles below its secret floor.
 */
import {
  NEED_URGENCY,
  type HaggleState,
  type MerchantReply,
  type MerchantSecret,
  type Personality,
  type PlayerMemory,
  type PlayerMove,
  type Tell,
} from "./types.js";

/** Offers below this fraction of the floor count as an insult. */
export const INSULT_RATIO = 0.85;
/** Concession multiplier when the player's offer is below the secret floor. */
export const BELOW_FLOOR_DAMPING = 0.35;
/** Each remembered lowball raises this player's opening ask by this much (capped at 5). */
export const GRUDGE_MARKUP = 0.08;

export function openHaggle(
  secret: MerchantSecret,
  personality: Personality,
  memory: PlayerMemory = { lowballs: 0, deals: 0 },
): HaggleState {
  const grudge = 1 + GRUDGE_MARKUP * Math.min(memory.lowballs, 5);
  return {
    secret,
    personality,
    ask: Math.round(secret.listPrice * grudge),
    round: 0,
    mood: 1,
    finalGiven: false,
    lowballed: false,
    status: "open",
    history: [],
  };
}

/** Rounds before the merchant names a final price. Comfortable merchants have less patience. */
export function maxRounds(secret: MerchantSecret, p: Personality): number {
  const urgency = NEED_URGENCY[secret.need];
  return 4 + Math.round(4 * urgency) + Math.round(2 * (1 - p.temper));
}

function tellFor(state: HaggleState): Tell {
  const { secret, ask, mood } = state;
  const span = Math.max(1, secret.listPrice - secret.floor);
  const headroom = (ask - secret.floor) / span; // 1 = at list, 0 = at floor
  if (mood < 0.35) return "irritated";
  if (headroom < 0.18) return "firm";
  if (NEED_URGENCY[secret.need] >= 0.6 && headroom < 0.55) return "nervous";
  return "relaxed";
}

function statedFloorFor(state: HaggleState): number | undefined {
  const { secret, personality, ask, round } = state;
  if (round < 2 || personality.bluff < 0.15) return undefined;
  // The lie: claims a floor above the truth, but never above its own current ask.
  const claim = Math.round(secret.floor * (1 + personality.bluff));
  return Math.min(claim, ask);
}

function close(state: HaggleState, move: PlayerMove, reply: MerchantReply): MerchantReply {
  state.history.push({ move, reply });
  return reply;
}

export function respond(state: HaggleState, move: PlayerMove): MerchantReply {
  if (state.status !== "open") throw new Error(`haggle is ${state.status}`);
  const { secret, personality: p } = state;
  const price = Math.round(move.price);
  if (!Number.isFinite(price) || price < 0) throw new Error("invalid price");
  state.round++;

  const deal = (at: number): MerchantReply => {
    state.status = "deal";
    state.dealPrice = at;
    return close(state, move, { action: "accept", price: at, tell: tellFor(state) });
  };
  const walk = (): MerchantReply => {
    state.status = "walked";
    return close(state, move, { action: "walk", price: state.ask, tell: "irritated" });
  };

  // 1. Meeting or beating the ask is always a deal (at the ask — no overpaying).
  if (price >= state.ask) return deal(state.ask);

  // 2. Mood: insults hurt, fair offers soothe.
  if (price < secret.floor * INSULT_RATIO) {
    state.lowballed = true;
    state.mood -= 0.2 + 0.35 * p.temper;
  } else if (price < secret.floor) {
    state.mood -= 0.06 * p.temper;
  } else {
    state.mood = Math.min(1, state.mood + 0.04);
  }
  if (state.mood <= 0) return walk();

  // 3. After a final price, anything short of it ends the haggle.
  if (state.finalGiven) return walk();

  const urgency = NEED_URGENCY[secret.need];
  const gap = state.ask - Math.max(price, secret.floor);

  // 4. Close enough to the ask (and at/above floor) → accept the player's price.
  const acceptBand = (state.ask - secret.floor) * (0.12 + 0.3 * urgency) * (1 - 0.5 * p.stubbornness);
  if (price >= secret.floor && state.ask - price <= acceptBand) return deal(price);

  // 5. Concede part of the gap. A credible competitor claim (at/above floor) adds pressure.
  const credibleClaim =
    move.competitorPrice !== undefined && move.competitorPrice >= secret.floor && move.competitorPrice < state.ask;
  let rate = (0.14 + 0.3 * urgency) * (1 - 0.6 * p.stubbornness) * (0.3 + 0.7 * state.mood);
  // Offers below the floor barely move the merchant: lowballing shouldn't be a shortcut.
  if (price < secret.floor) rate *= BELOW_FLOOR_DAMPING;
  if (credibleClaim) rate += 0.12;
  let next = Math.round(state.ask - gap * rate);
  next = Math.max(next, secret.floor, price + 1);
  if (next >= state.ask) next = Math.max(secret.floor, state.ask - 1);
  state.ask = Math.max(next, secret.floor);

  // 6. Out of patience → name a final price.
  if (state.round >= maxRounds(secret, p)) {
    state.finalGiven = true;
    return close(state, move, { action: "final", price: state.ask, tell: tellFor(state) });
  }

  return close(state, move, {
    action: "counter",
    price: state.ask,
    tell: tellFor(state),
    statedFloor: statedFloorFor(state),
  });
}

/**
 * Player chatted without naming a price. The merchant restates its position.
 * Doesn't consume a round or change state, so talking is free but never moves the price.
 */
export function holdReply(state: HaggleState): MerchantReply {
  if (state.status !== "open") throw new Error(`haggle is ${state.status}`);
  return {
    action: state.finalGiven ? "final" : "counter",
    price: state.ask,
    tell: tellFor(state),
    statedFloor: state.finalGiven ? undefined : statedFloorFor(state),
  };
}

/** Player explicitly takes the merchant's current ask. */
export function acceptAsk(state: HaggleState): MerchantReply {
  return respond(state, { price: state.ask });
}

/** Update what this merchant remembers about the player after a haggle ends. */
export function updateMemory(memory: PlayerMemory, state: HaggleState): PlayerMemory {
  return {
    lowballs: memory.lowballs + (state.lowballed ? 1 : 0),
    deals: memory.deals + (state.status === "deal" ? 1 : 0),
  };
}

/** Coins the player paid above the merchant's secret floor. Lower = better haggling. */
export function leftOnTable(state: HaggleState): number | undefined {
  return state.dealPrice === undefined ? undefined : state.dealPrice - state.secret.floor;
}
