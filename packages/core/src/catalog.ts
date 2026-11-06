import type { Good, Merchant } from "./types.js";
import { CUSTOMERS } from "./orders.js";

export const GOODS: Record<string, Good> = {
  rug: { id: "rug", name: "Silk Rug", baseValue: 60 },
  saffron: { id: "saffron", name: "Saffron (1 oz)", baseValue: 40 },
  lamp: { id: "lamp", name: "Brass Lamp", baseValue: 25 },
};

export const MERCHANTS: Merchant[] = [
  {
    id: "farrukh",
    name: "Old Farrukh",
    goodId: "rug",
    buysGoodId: "lamp",
    personality: { stubbornness: 0.75, temper: 0.3, bluff: 0.4 },
    tells: {
      relaxed: "strokes beard slowly",
      firm: "rests both palms flat on the counter",
      nervous: "keeps smoothing the same corner of a rug",
      irritated: "tugs at beard, hard",
    },
  },
  {
    id: "zaria",
    name: "Zaria the Spice-Seller",
    goodId: "saffron",
    buysGoodId: "rug",
    personality: { stubbornness: 0.35, temper: 0.85, bluff: 0.2 },
    tells: {
      relaxed: "sifts saffron threads through her fingers",
      firm: "snaps the lid of a jar shut",
      nervous: "drums her rings against a jar",
      irritated: "stops sifting, eyes narrowed",
    },
  },
  {
    id: "tobin",
    name: "Tobin of the Lamps",
    goodId: "lamp",
    buysGoodId: "saffron",
    personality: { stubbornness: 0.2, temper: 0.2, bluff: 0.1 },
    tells: {
      relaxed: "polishes a lamp, humming",
      firm: "puts the polishing cloth down",
      nervous: "pushes spectacles up the nose, twice",
      irritated: "snuffs out the little lamp on the counter",
    },
  },
];

/** Who's who in Canal Street's agent economy. Each one has its own NEAR account (see contracts/bazaar). */
export type AgentKind = "merchant" | "wholesaler" | "trader" | "runner" | "customer" | "cab";
export interface AgentDef {
  id: string;
  name: string;
  kind: AgentKind;
  blurb: string;
  /** Traders: which scripted strategy they haggle with (bots.ts). */
  bot?: string;
}

/** The wholesaler at the docks: sells every good in lots, to merchants. */
export const WHOLESALER: Merchant = {
  id: "wu",
  name: "Auntie Wu",
  goodId: "rug",
  buysGoodId: "rug",
  personality: { stubbornness: 0.6, temper: 0.15, bluff: 0.3 },
  tells: {
    relaxed: "counts crates, unbothered",
    firm: "taps the price chalked on a crate",
    nervous: "glances at the incoming tide",
    irritated: "waves the next buyer forward",
  },
};

export const AGENTS: AgentDef[] = [
  ...MERCHANTS.map((m) => ({ id: m.id, name: m.name, kind: "merchant" as const, blurb: `Sells ${GOODS[m.goodId].name}, buys ${GOODS[m.buysGoodId].name}` })),
  { id: WHOLESALER.id, name: WHOLESALER.name, kind: "wholesaler", blurb: "Sells every good in lots at the Pier 34 docks" },
  { id: "ivy", name: "Ivy the Flipper", kind: "trader", blurb: "Buys low at one stall, sells high at another. Calls bluffs.", bot: "sharp" },
  { id: "rex", name: "Rex Two-Coats", kind: "trader", blurb: "A patient trader who splits the difference.", bot: "splitter" },
  { id: "lo", name: "Little Lo", kind: "runner", blurb: "Hauls lots from the docks for a fee" },
  ...CUSTOMERS.map((c) => ({ id: c.id, name: c.name, kind: "customer" as const, blurb: c.blurb })),
  { id: "cab", name: "Checker Cab Co.", kind: "cab", blurb: "Earns the fare when you take a cab or a helicopter to a delivery" },
];
