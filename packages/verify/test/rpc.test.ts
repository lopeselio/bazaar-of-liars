import { describe, expect, it } from "vitest";
import { failover, rpcUrls } from "../src/rpc.js";

const ok = (body = "{}") => new Response(body, { status: 200 });
const busy = () => new Response("Too Many Requests", { status: 429 });
const read = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: {} }) };
const send = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "send_tx", params: {} }) };

function fake(script: Record<string, Array<() => Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = script[url]?.shift();
    if (!next) throw new TypeError("fetch failed");
    return next();
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("rpc failover", () => {
  it("lists your own endpoints first, without duplicates", () => {
    expect(rpcUrls("testnet", "https://mine.example, https://rpc.testnet.fastnear.com")).toEqual([
      "https://mine.example",
      "https://rpc.testnet.fastnear.com",
      "https://near-testnet.drpc.org",
      "https://testnet-rpc.intea.rs",
    ]);
    expect(rpcUrls("testnet", "")[0]).toBe("https://rpc.testnet.fastnear.com");
  });

  it("a 429 goes to the next endpoint with the same body, and the busy one cools down", async () => {
    let t = 0;
    const { f, calls } = fake({ a: [busy, ok], b: [() => ok('{"from":"b"}'), () => ok('{"from":"b2"}')] });
    const rpc = failover(["a", "b"], f, () => t);
    expect(await (await rpc.fetch("a", send)).text()).toBe('{"from":"b"}');
    expect(calls.map((c) => c.url)).toEqual(["a", "b"]);
    expect(calls[1]!.init.body).toBe(send.body);
    expect(rpc.cooling()).toEqual(["a"]);
    // While a cools down, b is asked first.
    expect(await (await rpc.fetch("a", read)).text()).toBe('{"from":"b2"}');
    expect(calls.map((c) => c.url)).toEqual(["a", "b", "b"]);
    t = 31_000;
    expect(rpc.cooling()).toEqual([]);
    expect((await rpc.fetch("a", read)).status).toBe(200);
    expect(calls.at(-1)!.url).toBe("a");
  });

  it("a network error or 5xx also fails over; a 4xx answer (other than 408/429) does not", async () => {
    const { f, calls } = fake({ b: [() => new Response("bad", { status: 503 })], c: [ok] });
    expect((await failover(["a", "b", "c"], f).fetch("a", read)).status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["a", "b", "c"]);
    const g = fake({ a: [() => new Response("nope", { status: 400 })] });
    expect((await failover(["a", "b"], g.f).fetch("a", read)).status).toBe(400);
    expect(g.calls).toHaveLength(1);
  });

  it("when every endpoint refuses, the last answer is returned (near-kit then backs off and retries)", async () => {
    const { f } = fake({ a: [busy], b: [busy] });
    expect((await failover(["a", "b"], f).fetch("a", read)).status).toBe(429);
    await expect(failover(["x"], fake({}).f).fetch("x", read)).rejects.toThrow("fetch failed");
  });

  it("reads get a client timeout; transactions wait for the node", async () => {
    const { f, calls } = fake({ a: [ok, ok] });
    const rpc = failover(["a"], f);
    await rpc.fetch("a", read);
    await rpc.fetch("a", send);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1]!.init.signal).toBeUndefined();
  });
});
