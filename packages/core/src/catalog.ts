import type { Good, Merchant } from "./types.js";

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
