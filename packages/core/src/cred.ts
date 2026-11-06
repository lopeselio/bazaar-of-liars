/**
 * Street cred: experience a player earns on Canal Street, kept onchain by the bazaar contract.
 *
 * The contract awards what it can see for itself (a closed deal, a delivery) and adds the daily
 * streak bonus. The server may add what only it sees (catching a merchant in a bluff), within a
 * daily cap the contract enforces. These constants MUST match contracts/bazaar.
 */

export const XP = {
  /** A haggle that ends in a deal. */
  deal: 5,
  /** A delivery, plus a bonus when it was an express job. */
  delivery: 10,
  expressBonus: 5,
  /** Catching a merchant in a bluff (server-awarded). */
  caughtBluff: 4,
  /** First XP of a UTC day: this × the streak length, capped at a week. */
  streakBonus: 5,
  streakCap: 7,
  /** Most server-awarded XP per player per UTC day. */
  serverDailyCap: 80,
} as const;

/** XP needed to reach a level: 0, 30, 120, 270, 480, 750, … */
export const xpForLevel = (level: number) => 30 * (level - 1) ** 2;
export const levelOf = (xp: number) => 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 30));

export const TITLES = ["Newcomer", "Street Runner", "Haggler", "Canal Regular", "Market Fixture", "Bluff Breaker", "Bazaar Legend"];
export const titleOf = (level: number) => TITLES[Math.min(level, TITLES.length) - 1];

/** What each level opens up. */
export const UNLOCKS: { level: number; what: string }[] = [
  { level: 2, what: "Express delivery jobs (bigger bounties, tighter clocks)" },
  { level: 3, what: "Jobs from the far side of town (Times Square, Central Park)" },
  { level: 5, what: "A stall licence on Canal Street (coming next)" },
];

/** Express jobs need level 2; far drop sites need level 3. */
export function canTake(level: number, order: { express: boolean; site: string }) {
  if (order.express && level < 2) return { ok: false, needs: 2 };
  if ((order.site === "timessq" || order.site === "centralpark") && level < 3) return { ok: false, needs: 3 };
  return { ok: true as const, needs: level };
}

export interface CredView {
  xp: number;
  level: number;
  title: string;
  /** XP at the start of this level and at the next. */
  levelXp: number;
  nextXp: number;
  streak: number;
  bestStreak: number;
  /** True if the player has already earned XP today (so today's streak bonus is banked). */
  activeToday: boolean;
}

export function credView(raw: { xp: number; streak: number; best_streak: number; last_day: number }, today: number): CredView {
  const level = levelOf(raw.xp);
  // A streak only survives if the last active day was today or yesterday.
  const streak = raw.last_day >= today - 1 ? raw.streak : 0;
  return {
    xp: raw.xp,
    level,
    title: titleOf(level),
    levelXp: xpForLevel(level),
    nextXp: xpForLevel(level + 1),
    streak,
    bestStreak: raw.best_streak,
    activeToday: raw.last_day === today,
  };
}
