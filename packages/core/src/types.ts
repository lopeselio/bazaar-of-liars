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
  /** What the merchant sells to players. */
  goodId: string;
  /** What the merchant buys from players. */
  buysGoodId: string;
  personality: Personality;
  /** How each tell leaks, in this merchant's own body language (stage directions for the model). */
  tells: Record<Tell, string>;
}

/**
 * Which way the goods move. "sell": the merchant sells to the player. "buy": the merchant buys
 * from the player. In a buy haggle, prices run the other way: the merchant opens LOW and the
 * secret `floor` field is its CEILING, the most it will pay.
 */
export type Side = "sell" | "buy";

/** The hidden hand. Committed onchain before the haggle opens; revealed at settle. */
export interface MerchantSecret {
  side: Side;
  merchantId: string;
  goodId: string;
  /** side "sell": the lowest price it will accept. side "buy": the highest it will pay. */
  floor: number;
  need: Need;
  /** Seeds dialogue/claim variation so the replay is reproducible. */
  seed: number;
  /** Public opening price (before memory adjustments), bound into the commitment. */
  listPrice: number;
  /** Remembered lowballs by this player, 0..5. Checked by the contract against its own record. */
  grudge: number;
  /** Remembered deals with this player, 0..5. Checked by the contract too. */
  loyalty: number;
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
  /**
   * A claimed limit ("I can't go below X" / "I can't pay more than X"). Sometimes the truth,
   * often a lie. Only present on a counter, and always strictly better for the merchant than
   * the real limit would be, or equal to it.
   */
  statedFloor?: number;
  /** Set on the reply to a called bluff: "caught" = it was a lie, "honest" = it was the truth. */
  call?: "caught" | "honest";
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
  /** The merchant's live claim, which the player may call. Cleared once called. */
  claim?: number;
  /** Caught lying once: no more claims this haggle. */
  caught: boolean;
  /** Opening ask after memory adjustments. Honest merchants who are called liars raise toward it. */
  openAsk: number;
  status: HaggleStatus;
  dealPrice?: number;
  history: { move: PlayerMove; reply: MerchantReply }[];
}
