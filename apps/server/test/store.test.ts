/**
 * The store contract, run against memory and (when TEST_REDIS_URL is set) a real Redis.
 *   docker run -d -p 6390:6379 redis:7-alpine && TEST_REDIS_URL=redis://localhost:6390 pnpm test
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { memoryStore, redisStore, type LiveRecord, type Store } from "../src/store.js";

const rec = (id: string, lastActive: number): LiveRecord => ({
  snap: { v: 1, id } as LiveRecord["snap"],
  player: "guest-00000001",
  budget: 200,
  lastActive,
  turns: 0,
});

const backends: [string, () => Promise<Store>][] = [["memory", async () => memoryStore()]];
const url = process.env.TEST_REDIS_URL;
if (url) backends.push(["redis", () => redisStore(url, `{test-${randomUUID()}}:`)]);

describe.each(backends)("%s store", (_name, make) => {
  const ready = make();
  afterAll(async () => (await ready).close());

  it("saves, finds idle and deletes live haggles", async () => {
    const s = await ready;
    await s.putLive(rec("a", 1_000), 60_000);
    await s.putLive(rec("b", 5_000), 60_000);
    expect((await s.getLive("a"))?.budget).toBe(200);
    expect(await s.idleIds(2_000)).toEqual(["a"]);
    await s.deleteLive("a");
    expect(await s.getLive("a")).toBeNull();
    expect(await s.idleIds(10_000)).toEqual(["b"]);
  });

  it("lets only one holder lock a haggle", async () => {
    const s = await ready;
    const t = await s.lock("h", 10_000);
    expect(t).toBeTruthy();
    expect(await s.lock("h", 10_000)).toBeNull();
    await s.unlock("h", "not-the-token");
    expect(await s.lock("h", 10_000)).toBeNull();
    await s.unlock("h", t!);
    expect(await s.lock("h", 10_000)).toBeTruthy();
  });

  it("clears a player's active haggle only if it's still that one", async () => {
    const s = await ready;
    await s.setActive("p", "one", 60_000);
    await s.clearActive("p", "two");
    expect(await s.getActive("p")).toBe("one");
    await s.clearActive("p", "one");
    expect(await s.getActive("p")).toBeNull();
  });

  it("rate-limits within a window", async () => {
    const s = await ready;
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await s.hit("ip", 60_000, 3));
    expect(r).toEqual([true, true, true, false]);
  });

  it("keeps market days", async () => {
    const s = await ready;
    expect(await s.getDay("p")).toBeNull();
    await s.putDay("p", { n: 2, left: 5, startWorth: 210 }, 60_000);
    expect(await s.getDay("p")).toEqual({ n: 2, left: 5, startWorth: 210 });
  });

  it("keeps a capped, newest-first news feed and decaying counters", async () => {
    const s = await ready;
    for (let i = 0; i < 5; i++) await s.pushNews({ t: i, kind: "sale", text: `n${i}`, agents: [] }, 3);
    expect((await s.news(10)).map((x) => x.text)).toEqual(["n4", "n3", "n2"]);
    expect(await s.bump("sales:x", 60_000)).toBe(1);
    expect(await s.bump("sales:x", 60_000)).toBe(2);
    expect(await s.count("sales:x")).toBe(2);
    expect(await s.count("sales:y")).toBe(0);
  });

  it("keeps small JSON records", async () => {
    const s = await ready;
    await s.putJSON("job:p", { orderId: "o1", at: 5 }, 60_000);
    expect(await s.getJSON("job:p")).toEqual({ orderId: "o1", at: 5 });
    await s.del("job:p");
    expect(await s.getJSON("job:p")).toBeNull();
  });
});
