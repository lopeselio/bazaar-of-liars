/**
 * Dock work at Pier 34: the safety net for a broke player.
 *
 * A player with almost nothing in their purse can walk to the west end of Canal Street and work
 * one shift a day unloading crates for Auntie Wu, the wholesaler. She pays the wage from her own
 * purse, signing for it herself; the contract checks the player really is broke and hasn't
 * already worked today. No coins are created: the money comes from what merchants pay her.
 *
 * Constants MUST match contracts/bazaar.
 */

/** West St & Canal St, by Pier 34 (Slop New York world metres). */
export const DOCK = { x: -744, z: 3926, name: "Pier 34 docks" };
/** A shift pays this. */
export const DOCK_WAGE = 40;
/** Only players with fewer coins than this can work a shift. */
export const BROKE_BELOW = 20;
/** How close to the docks the player must be (metres). */
export const DOCK_REACH = 45;

export const isBroke = (coins: number) => coins < BROKE_BELOW;
