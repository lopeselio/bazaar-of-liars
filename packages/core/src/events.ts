/**
 * Street events: every twelve minutes or so something happens on the street, and the contract
 * rolls what it is.
 *
 * - Festival: buyers across town pay a quarter more and customers post more delivery orders.
 * - Shortage of one good: it costs 30% more at the docks and buyers pay 40% more for it.
 * - Inspector raid on Canal Street: an unlicensed player who haggles there while it's on loses
 *   whatever they carry above 5 of any good (the contract confiscates it). Rival traders lie low.
 *
 * Constants MUST match contracts/bazaar.
 */
export const EVENT_GAP_MS = 12 * 60_000;
export const EVENT_MS = 4 * 60_000;
export const RAID_LIMIT = 5;

export type EventKind = "festival" | "shortage" | "raid";
export interface StreetEvent {
  id: string;
  kind: EventKind;
  good_id: string;
  start_ms: number;
  end_ms: number;
  seized: number;
}

export const eventActive = (e: StreetEvent | null | undefined, now = Date.now()): e is StreetEvent => !!e && now >= e.start_ms && now < e.end_ms;

/** What buyers pay for a good, as a multiple of their usual price. */
export function bidMultiplier(e: StreetEvent | null | undefined, goodId: string, now = Date.now()): number {
  if (!eventActive(e, now)) return 1;
  if (e.kind === "festival") return 1.25;
  if (e.kind === "shortage" && e.good_id === goodId) return 1.4;
  return 1;
}

/** What the docks charge for a good, as a multiple of the usual price. */
export function askMultiplier(e: StreetEvent | null | undefined, goodId: string, now = Date.now()): number {
  return eventActive(e, now) && e.kind === "shortage" && e.good_id === goodId ? 1.3 : 1;
}

/** Extra open delivery orders customers aim for, and how much more they pay. */
export function orderBoost(e: StreetEvent | null | undefined, now = Date.now()): { extraOrders: number; bounty: number } {
  return eventActive(e, now) && e.kind === "festival" ? { extraOrders: 3, bounty: 1.25 } : { extraOrders: 0, bounty: 1 };
}

/** Rival traders lie low while the inspectors are about. */
export const tradersLieLow = (e: StreetEvent | null | undefined, now = Date.now()) => eventActive(e, now) && e.kind === "raid";

/** What a raid would take from someone carrying these goods. */
export const raidSeizes = (goods: Record<string, number>) => Object.values(goods).reduce((s, n) => s + Math.max(0, n - RAID_LIMIT), 0);

export function eventHeadline(e: StreetEvent, goodName: (id: string) => string): string {
  if (e.kind === "festival") return "🎉 Street festival! Buyers across town pay 25% more, and customers want more deliveries.";
  if (e.kind === "shortage") return `📉 ${goodName(e.good_id)} shortage! It costs 30% more at the docks and buyers pay 40% more for it.`;
  return `🚨 Inspectors on Canal Street! Unlicensed traders who haggle there lose anything over ${RAID_LIMIT} of a good.`;
}
