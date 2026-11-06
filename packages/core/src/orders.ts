/**
 * Delivery jobs across Manhattan: customers around the city post orders for goods sold on Canal
 * Street, and players race the clock to deliver them. All the rules in one place: where the
 * customers are, what they pay, how long they wait, and what a cab or helicopter costs.
 *
 * Coordinates are Slop New York world metres (x east, z south; Canal St is at z ≈ 4200).
 * Customers are agents with their own NEAR accounts: each one locks its bounty in the contract
 * when it posts an order, and the contract pays the player on delivery (contracts/bazaar).
 */
import type { Rng } from "./rng.js";

export interface DropSite {
  id: string;
  name: string;
  district: string;
  x: number;
  z: number;
}

/** Where the stalls are: the middle of Canal Street in Chinatown. */
export const CANAL_ORIGIN = { x: 430, z: 4220 };

/** Street-level drop points (Slop New York teleport spots near each landmark). */
export const DROP_SITES: DropSite[] = [
  { id: "owtc", name: "One World Trade Center", district: "Financial District", x: -306, z: 5210 },
  { id: "flatiron", name: "Flatiron Building", district: "Flatiron District", x: 4, z: 1353 },
  { id: "empire", name: "Empire State Building", district: "Midtown South", x: 4, z: 477 },
  { id: "grandcentral", name: "Grand Central", district: "Midtown East", x: 303, z: 163 },
  { id: "bryant", name: "Bryant Park", district: "Midtown", x: -307, z: 85 },
  { id: "timessq", name: "Times Square", district: "Theater District", x: -581, z: -324 },
  { id: "centralpark", name: "Central Park South", district: "Uptown", x: -307, z: -1204 },
];
export const siteById = (id: string) => DROP_SITES.find((s) => s.id === id);

export interface Customer {
  /** Agent id; its account is `<id>.<contract>`. */
  id: string;
  name: string;
  siteId: string;
  wants: string[];
  blurb: string;
}

export const CUSTOMERS: Customer[] = [
  { id: "vesey", name: "Vesey Street Gallery", siteId: "owtc", wants: ["rug", "lamp"], blurb: "Dresses its lobby with whatever looks expensive" },
  { id: "teahouse", name: "Flatiron Tea Room", siteId: "flatiron", wants: ["saffron", "lamp"], blurb: "Always one lamp short of cosy" },
  { id: "deli", name: "Mama Rosa's Deli", siteId: "timessq", wants: ["saffron"], blurb: "Saffron for the Saturday risotto" },
  { id: "hotel", name: "The Concourse Hotel", siteId: "grandcentral", wants: ["rug", "lamp"], blurb: "Redecorating suite by suite" },
  { id: "dowager", name: "The Dowager of 59th St", siteId: "centralpark", wants: ["rug", "saffron"], blurb: "Pays well, waits for no one" },
];

/** Straight-line metres, stretched for the street grid. */
export const routeMetres = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.round(Math.hypot(a.x - b.x, a.z - b.z) * 1.25);

// ---------- terms of an order ----------

/** One game minute is one real second, so a market day is 24 real minutes. */
export const GAME_MINUTE_MS = 1000;
/** Planning speeds (m/s): a runner on foot, and a cab through traffic. */
export const FOOT_MPS = 6;
export const CAB_MPS = 18;

export interface OrderTerms {
  goodId: string;
  siteId: string;
  /** Coins the customer locks in the contract and pays on delivery. */
  bounty: number;
  /** How long the customer waits, in ms of real time. */
  windowMs: number;
  /** Express: only a cab or a helicopter gets there in time, and it pays for it. */
  express: boolean;
  metres: number;
}

/**
 * What a customer offers for one good delivered to its door.
 * The bounty covers the good's street value plus the trip; express jobs pay extra but their
 * window is too short to walk.
 */
export function orderTerms(rng: Rng, customer: Customer, goodBaseValue: Record<string, number>): OrderTerms {
  const site = siteById(customer.siteId)!;
  const goodId = customer.wants[Math.floor(rng() * customer.wants.length)];
  const metres = routeMetres(CANAL_ORIGIN, site);
  const km = metres / 1000;
  const express = rng() < 0.3;
  const walkMs = (metres / FOOT_MPS) * 1000;
  const cabMs = (metres / CAB_MPS) * 1000;
  // Time to buy the good first, then travel with some slack.
  const windowMs = Math.round(90_000 + (express ? cabMs * (1.4 + 0.4 * rng()) : walkMs * (1.25 + 0.5 * rng())));
  const bounty = Math.round(goodBaseValue[goodId] * (1.15 + 0.25 * rng()) + km * 6 + (express ? 12 + km * 4 : 0));
  return { goodId, siteId: site.id, bounty, windowMs, express, metres };
}

// ---------- getting there ----------

export type TravelMode = "foot" | "bike" | "cab" | "heli";

/**
 * How the player must have travelled, from distance and time alone (we don't trust a claimed mode).
 * Average speeds: running tops out at 8.2 m/s, a bike at 19, a cab at 36.
 * Returns null when nothing in the city could have made it that fast.
 */
export function impliedMode(metres: number, elapsedMs: number): TravelMode | null {
  const mps = metres / Math.max(1, elapsedMs / 1000);
  if (mps <= 8.5) return "foot";
  if (mps <= 19.5) return "bike";
  if (mps <= 36) return "cab";
  if (mps <= 75) return "heli";
  return null;
}

/** What the trip costs. Walking and cycling are free; a cab or helicopter is paid out of the bounty. */
export function fare(mode: TravelMode, metres: number): number {
  const km = metres / 1000;
  if (mode === "cab") return Math.round(3 + km * 4);
  if (mode === "heli") return Math.round(10 + km * 10);
  return 0;
}

/** Street cred earned for a delivery: more for distance and for beating the clock. */
export function deliveryCred(metres: number, express: boolean, msToSpare: number): number {
  return Math.round(2 + metres / 1500 + (express ? 2 : 0) + (msToSpare > 60_000 ? 1 : 0));
}
