/**
 * Things the player just did, announced on window as `bz:signal` so the starter quests
 * (quests.ts) can follow along without the game modules knowing about them.
 */
export type Signal =
  /** A haggle ended in a deal (either side). */
  | "haggled"
  /** The player called a merchant's bluff, caught or not. */
  | "bluff"
  /** A delivery job taken from the board. */
  | "job-taken"
  /** A delivery handed over and settled. */
  | "delivered"
  /** A tip bought from an informant; detail.who is the informant's id. */
  | "tip"
  /** A sealed bid on the cargo at Pier 34. */
  | "bid"
  /** A trade at a price board. */
  | "route-trade"
  /** The 📈 chip started guiding to a trade route. */
  | "route-guide";

export function signal(kind: Signal, who?: string) {
  dispatchEvent(new CustomEvent("bz:signal", { detail: { kind, who } }));
}

export function onSignal(fn: (kind: Signal, who?: string) => void) {
  addEventListener("bz:signal", (e) => {
    const d = (e as CustomEvent<{ kind: Signal; who?: string }>).detail;
    if (d) fn(d.kind, d.who);
  });
}
