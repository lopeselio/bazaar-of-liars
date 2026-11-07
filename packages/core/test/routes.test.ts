import { describe, expect, it } from "vitest";
import { BOARDS, askPrice, bestRoute, bidPrice, boardById, type PricedBoard } from "../src/index.js";

describe("price boards", () => {
  it("Wu sells cheaper when she has plenty, keeps some back, and never goes below cost", () => {
    expect(askPrice(60, 12, 0)).toBe(47);
    expect(askPrice(60, 6, 0)).toBe(56);
    expect(askPrice(60, 4, 0)).toBeNull();
    expect(askPrice(60, 12, 51.5)).toBe(52);
  });

  it("buyers further from Canal Street pay more, and less as they fill up", () => {
    const near = bidPrice(60, boardById("vesey")!, 0)!;
    const far = bidPrice(60, boardById("dowager")!, 0)!;
    expect(far).toBeGreaterThan(near);
    expect(bidPrice(60, boardById("dowager")!, 3)!).toBeLessThan(far);
    expect(bidPrice(60, boardById("vesey")!, 3)).toBeNull();
  });

  it("finds the best spread", () => {
    const priced: PricedBoard[] = BOARDS.map((b) => ({ ...b, prices: Object.fromEntries(b.goods.map((g) => [g, b.kind === "sells" ? 40 : b.id === "dowager" && g === "rug" ? 80 : 50])) }));
    expect(bestRoute(priced)).toMatchObject({ goodId: "rug", buyAt: "docks", sellAt: "dowager", profit: 40 });
  });
});
