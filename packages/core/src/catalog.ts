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
    personality: { stubbornness: 0.75, temper: 0.3, bluff: 0.4 },
  },
  {
    id: "zaria",
    name: "Zaria the Spice-Seller",
    goodId: "saffron",
    personality: { stubbornness: 0.35, temper: 0.85, bluff: 0.2 },
  },
  {
    id: "tobin",
    name: "Tobin of the Lamps",
    goodId: "lamp",
    personality: { stubbornness: 0.2, temper: 0.2, bluff: 0.1 },
  },
];
