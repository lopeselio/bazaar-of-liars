/** What a merchant secretly needs. Drives how fast it concedes. Revealed after the deal. */
export type Need = "rent_due" | "restocking" | "comfortable" | "hoarding";

export const NEED_URGENCY: Record<Need, number> = {
  rent_due: 1.0,
  restocking: 0.6,
  comfortable: 0.3,
  hoarding: 0.0,
};

export interface Personality {
  /** 0..1 — how slowly the merchant concedes. */
  stubbornness: number;
  /** 0..1 — how fast lowballs sour its mood. */
  temper: number;
  /** 0..0.5 — how much it inflates the "I can't go below X" lie. */
  bluff: number;
}

export interface Good {
  id: string;
  name: string;
  baseValue: number;
}

export interface Merchant {
  id: string;
  name: string;
  goodId: string;
  personality: Personality;
}

/** The hidden hand. Committed onchain before the haggle opens; revealed at settle. */
export interface MerchantSecret {
  merchantId: string;
  goodId: string;
  floor: number;
  need: Need;
  /** Seeds dialogue/personality variation so the reveal is reproducible. */
  seed: number;
  /** Public opening price, bound into the commitment so it can't be swapped. */
  listPrice: number;
}

export type Tell = "relaxed" | "firm" | "nervous" | "irritated";

export type MerchantAction = "counter" | "final" | "accept" | "walk";

export interface PlayerMove {
  price: number;
  /** Optional claim, e.g. "I saw this for 40 next door". The LLM layer extracts it from chat. */
  competitorPrice?: number;
}

export interface MerchantReply {
  action: MerchantAction;
  /** Counter/final ask, or the agreed deal price on accept. */
  price: number;
  tell: Tell;
  /** A claimed floor. Usually a lie (above the real floor). Absent when it says nothing. */
  statedFloor?: number;
}

export interface PlayerMemory {
  lowballs: number;
  deals: number;
}

export type HaggleStatus = "open" | "deal" | "walked";

export interface HaggleState {
  secret: MerchantSecret;
  personality: Personality;
  ask: number;
  round: number;
  /** 1 = cheerful, 0 = walks away. */
  mood: number;
  finalGiven: boolean;
  lowballed: boolean;
  status: HaggleStatus;
  dealPrice?: number;
  history: { move: PlayerMove; reply: MerchantReply }[];
}
