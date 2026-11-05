/**
 * The merchant rules engine — the ONLY thing that decides accept / counter / walk.
 * The LLM layer writes dialogue around these decisions; it can never override them.
 *
 * Invariants (fuzz-tested):
 *   side "sell": a merchant never accepts, counters, or settles below its secret floor.
 *   side "buy":  a merchant never offers or pays above its secret ceiling.
 *
 * Buy haggles reuse the sell logic by mirroring prices around 2 × ceiling: x ↦ 2C − x.
 * The ceiling maps to itself, differences are preserved, and "the merchant concedes down
 * toward its floor" becomes "the merchant raises its bid up toward its ceiling". One engine,
 * one set of tests, both directions.
 */
import { mulberry32 } from "./rng.js";
import {
  NEED_URGENCY,
  type HaggleState,
  type MerchantReply,
  type MerchantSecret,
  type Personality,
  type PlayerMove,
  type PlayerMemory,
  type Tell,
} from "./types.js";

/** Offers below this fraction of the floor count as an insult. */
export const INSULT_RATIO = 0.85;
/** Concession multiplier when the player's offer is below the secret floor. */
export const BELOW_FLOOR_DAMPING = 0.35;
/** Each remembered lowball worsens this player's opening price by this much (max 5). */
export const GRUDGE_MARKUP = 0.08;
/** Each remembered deal improves it by this much (max 5). */
export const LOYALTY_DISCOUNT = 0.02;
/** A merchant caught bluffing gives up this share of its remaining margin. */
export const CAUGHT_CONCESSION = 0.65;

// ---------- sell-space plumbing ----------

/** Run `fn` on a sell-space view of the state, then write the results back. */
function inSellSpace<T extends MerchantReply | void>(state: HaggleState, fn: (s: HaggleState) => T): T {
  if (state.secret.side !== "buy") return fn(state);
  const P = 2 * state.secret.floor;
  const m = (x: number) => P - x;
  const mo = (x: number | undefined) => (x === undefined ? undefined : m(x));
  const view: HaggleState = {
    ...state,
    secret: { ...state.secret, listPrice: m(state.secret.listPrice) },
    ask: m(state.ask),
    openAsk: m(state.openAsk),
    claim: mo(state.claim),
    dealPrice: mo(state.dealPrice),
    history: [],
  };
  const r = fn(view);
  Object.assign(state, {
    ask: m(view.ask),
    round: view.round,
    mood: view.mood,
    finalGiven: view.finalGiven,
    lowballed: view.lowballed,
    caught: view.caught,
    status: view.status,
    claim: mo(view.claim),
    dealPrice: mo(view.dealPrice),
  });
  if (!r) return r;
  const reply = r as MerchantReply;
  return { ...reply, price: m(reply.price), ...(reply.statedFloor !== undefined ? { statedFloor: m(reply.statedFloor) } : {}) } as T;
}

const toSellSpace = (state: HaggleState, move: PlayerMove): PlayerMove => {
  if (state.secret.side !== "buy") return move;
  const P = 2 * state.secret.floor;
  return {
    price: Math.max(0, P - Math.round(move.price)),
    ...(move.competitorPrice !== undefined ? { competitorPrice: Math.max(0, P - move.competitorPrice) } : {}),
  };
};

// ---------- opening ----------

export function openHaggle(secret: MerchantSecret, personality: Personality): HaggleState {
  const factor = 1 + GRUDGE_MARKUP * Math.min(secret.grudge, 5) - LOYALTY_DISCOUNT * Math.min(secret.loyalty, 5);
  const state: HaggleState = {
    secret,
    personality,
    ask: 0,
    openAsk: 0,
    round: 0,
    mood: 1,
    finalGiven: false,
    lowballed: false,
    caught: false,
    status: "open",
    history: [],
  };
  // Memory adjusts the opening price against the player, in either direction.
  if (secret.side === "buy") {
    const P = 2 * secret.floor;
    state.ask = Math.max(1, P - Math.round((P - secret.listPrice) * factor));
  } else {
    state.ask = Math.max(secret.floor, Math.round(secret.listPrice * factor));
  }
  state.openAsk = state.ask;
  return state;
}

/** Rounds before the merchant names a final price. Comfortable merchants have less patience. */
export function maxRounds(secret: MerchantSecret, p: Personality): number {
  const urgency = NEED_URGENCY[secret.need];
  return 4 + Math.round(4 * urgency) + Math.round(2 * (1 - p.temper));
}

// ---------- sell-space core ----------

const headroomOf = (s: HaggleState) => (s.ask - s.secret.floor) / Math.max(1, s.secret.listPrice - s.secret.floor);

function tellFor(state: HaggleState): Tell {
  const headroom = headroomOf(state);
  if (state.mood < 0.35) return "irritated";
  if (headroom < 0.18) return "firm";
  if (NEED_URGENCY[state.secret.need] >= 0.6 && headroom < 0.55) return "nervous";
  return "relaxed";
}

/**
 * Sometimes the merchant names a limit. Near the floor it's usually the truth; far from it,
 * bluffers usually lie. Seeded by (secret.seed, round) so a verifier replays it exactly.
 * Never claims a limit it would have to break by its own current ask.
 */
function claimFor(state: HaggleState): number | undefined {
  const { secret, personality: p, ask, round, caught } = state;
  if (caught || round < 2 || ask <= secret.floor) return undefined;
  const r = mulberry32((secret.seed + round * 7919) >>> 0);
  if (r() > 0.55) return undefined;
  const nearFloor = headroomOf(state) < 0.25;
  const lieChance = nearFloor ? p.bluff : 0.3 + 1.2 * p.bluff;
  if (r() < lieChance) {
    const lie = Math.round(secret.floor * (1 + Math.max(0.06, p.bluff) * (0.6 + 0.8 * r())));
    const claim = Math.min(lie, ask - 1);
    if (claim > secret.floor) return claim;
  }
  return secret.floor; // the truth
}

/** A merchant telling the truth about its limit is at the wall, and its body shows it. */
const tellWithClaim = (state: HaggleState) =>
  state.claim !== undefined && state.claim === state.secret.floor && state.mood >= 0.35 ? "firm" : tellFor(state);

function counter(state: HaggleState): MerchantReply {
  const claim = claimFor(state);
  if (claim !== undefined) state.claim = claim;
  return { action: "counter", price: state.ask, tell: claim !== undefined ? tellWithClaim(state) : tellFor(state), ...(claim !== undefined ? { statedFloor: claim } : {}) };
}

function respondCore(state: HaggleState, move: PlayerMove): MerchantReply {
  const { secret, personality: p } = state;
  const price = Math.round(move.price);
  if (!Number.isFinite(price) || price < 0) throw new Error("invalid price");
  state.round++;

  const deal = (at: number): MerchantReply => {
    state.status = "deal";
    state.dealPrice = at;
    state.claim = undefined;
    return { action: "accept", price: at, tell: tellFor(state) };
  };
  const walk = (): MerchantReply => {
    state.status = "walked";
    state.claim = undefined;
    return { action: "walk", price: state.ask, tell: "irritated" };
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
    state.claim = undefined;
    return { action: "final", price: state.ask, tell: tellFor(state) };
  }
  return counter(state);
}

/**
 * The player calls the merchant's claimed limit a lie.
 *  - It WAS a lie: the merchant loses face, gives up most of its margin, and stops bluffing.
 *  - It was the TRUTH: the merchant is offended. Its mood drops, it raises its price back
 *    toward the opening and makes that final, or walks away.
 */
function callCore(state: HaggleState): MerchantReply {
  const { secret, personality: p } = state;
  const claim = state.claim!;
  state.claim = undefined;
  state.round++;
  if (claim > secret.floor) {
    state.caught = true;
    state.mood = Math.max(0.2, state.mood - 0.05);
    state.ask = Math.max(secret.floor, Math.round(secret.floor + (state.ask - secret.floor) * (1 - CAUGHT_CONCESSION)));
    return { action: "counter", price: state.ask, tell: "nervous", call: "caught" };
  }
  state.mood -= 0.3 + 0.35 * p.temper;
  if (state.mood <= 0) {
    state.status = "walked";
    return { action: "walk", price: state.ask, tell: "irritated", call: "honest" };
  }
  state.ask = Math.min(state.openAsk, state.ask + Math.round((state.openAsk - secret.floor) * 0.15));
  state.finalGiven = true;
  return { action: "final", price: state.ask, tell: "irritated", call: "honest" };
}

function holdCore(state: HaggleState): MerchantReply {
  if (state.finalGiven) return { action: "final", price: state.ask, tell: tellFor(state) };
  // Restating a position repeats the live claim (if any) rather than inventing a new one.
  return {
    action: "counter",
    price: state.ask,
    tell: tellWithClaim(state),
    ...(state.claim !== undefined ? { statedFloor: state.claim } : {}),
  };
}

// ---------- public API (real prices, either side) ----------

const assertOpen = (state: HaggleState) => {
  if (state.status !== "open") throw new Error(`haggle is ${state.status}`);
};

export function respond(state: HaggleState, move: PlayerMove): MerchantReply {
  assertOpen(state);
  const reply = inSellSpace(state, (s) => respondCore(s, toSellSpace(state, move)));
  state.history.push({ move, reply });
  return reply;
}

/** Player explicitly takes the merchant's current price. */
export function acceptAsk(state: HaggleState): MerchantReply {
  return respond(state, { price: state.ask });
}

/** True when there's a live claim the player could call. */
export const canCall = (state: HaggleState) => state.status === "open" && state.claim !== undefined;

/** Player calls the bluff. With no live claim, it's just talk (no state change). */
export function callBluff(state: HaggleState): MerchantReply {
  assertOpen(state);
  if (!canCall(state)) return holdReply(state);
  const reply = inSellSpace(state, callCore);
  state.history.push({ move: { price: state.ask }, reply });
  return reply;
}

/**
 * Player chatted without naming a price. The merchant restates its position.
 * Doesn't consume a round or change state, so talking is free but never moves the price.
 */
export function holdReply(state: HaggleState): MerchantReply {
  assertOpen(state);
  return inSellSpace(state, holdCore);
}

/** Update what this merchant remembers about the player after a haggle ends. */
export function updateMemory(memory: PlayerMemory, state: HaggleState): PlayerMemory {
  return {
    lowballs: memory.lowballs + (state.lowballed ? 1 : 0),
    deals: memory.deals + (state.status === "deal" ? 1 : 0),
  };
}

/** Coins the player conceded beyond the merchant's secret limit. 0 = perfect haggling. */
export function leftOnTable(state: HaggleState): number | undefined {
  if (state.dealPrice === undefined) return undefined;
  return state.secret.side === "buy" ? state.secret.floor - state.dealPrice : state.dealPrice - state.secret.floor;
}

/** Did this claim lie? (For reveals.) A claim equal to the limit is the truth. */
export const isBluff = (secret: MerchantSecret, claim: number) => claim !== secret.floor;
