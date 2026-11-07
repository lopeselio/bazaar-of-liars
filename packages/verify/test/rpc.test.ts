import { describe, expect, it } from "vitest";
import { failover, routed, rpcUrls } from "../src/rpc.js";

const ok = (body = "{}") => new Response(body, { status: 200 });
const busy = () => new Response("Too Many Requests", { status: 429 });
const read = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: {} }) };
const send = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "send_tx", params: {} }) };

function fake(script: Record<string, Array<() => Response>>) {
  const calls: Array<{ url: string; init: RequestInit; res?: Response }> = [];
  const f = (async (url: string, init: RequestInit) => {
    const call: (typeof calls)[number] = { url, init };
    calls.push(call);
    const next = script[url]?.shift();
    if (!next) throw new TypeError("fetch failed");
    return (call.res = next());
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("rpc failover", () => {
  it("lists your own endpoints first for NEAR_NETWORK only, normalised, without duplicates", () => {
    const env = { NEAR_RPC_URL: "https://mine.example/, https://rpc.testnet.fastnear.com", NEAR_NETWORK: "testnet" };
    expect(rpcUrls("testnet", env)).toEqual(["https://mine.example", "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs"]);
    expect(rpcUrls("mainnet", env)[0]).toBe("https://rpc.mainnet.fastnear.com");
    expect(rpcUrls("testnet", {})[0]).toBe("https://rpc.testnet.fastnear.com");
  });

  it("a 429 goes to the next endpoint with the same body, and the busy one cools down", async () => {
    let t = 0;
    const { f, calls } = fake({ a: [busy, ok], b: [() => ok('{"from":"b"}'), () => ok('{"from":"b2"}')] });
    const rpc = failover(["a", "b"], f, () => t);
    expect(await (await rpc.fetch("a", send)).text()).toBe('{"from":"b"}');
    expect(calls.map((c) => c.url)).toEqual(["a", "b"]);
    expect(calls[1]!.init.body).toBe(send.body);
    expect(calls[0]!.res!.bodyUsed || calls[0]!.res!.body?.locked).toBeTruthy(); // the 429's body was released
    expect(rpc.cooling()).toEqual(["a"]);
    expect(await (await rpc.fetch("a", read)).text()).toBe('{"from":"b2"}'); // b first while a cools down
    expect(calls.map((c) => c.url)).toEqual(["a", "b", "b"]);
    t = 31_000;
    expect(rpc.cooling()).toEqual([]);
    expect((await rpc.fetch("a", read)).status).toBe(200);
    expect(calls.at(-1)!.url).toBe("a");
  });

  it("a read fails over on a network error or 5xx; a 4xx answer (other than 408/429) is final", async () => {
    const { f, calls } = fake({ b: [() => new Response("bad", { status: 503 })], c: [ok] });
    expect((await failover(["a", "b", "c"], f).fetch("a", read)).status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["a", "b", "c"]);
    const g = fake({ a: [() => new Response("nope", { status: 400 })] });
    expect((await failover(["a", "b"], g.f).fetch("a", read)).status).toBe(400);
    expect(g.calls).toHaveLength(1);
  });

  it("a transaction never fails over on an ambiguous error: 5xx or no answer go back to near-kit", async () => {
    const five = fake({ a: [() => new Response("bad gateway", { status: 502 })], b: [ok] });
    expect((await failover(["a", "b"], five.f).fetch("a", send)).status).toBe(502);
    expect(five.calls.map((c) => c.url)).toEqual(["a"]);
    const lost = fake({ b: [ok] });
    await expect(failover(["a", "b"], lost.f).fetch("a", send)).rejects.toThrow("fetch failed");
    expect(lost.calls.map((c) => c.url)).toEqual(["a"]);
  });

  it("a transaction status query is a read: it fails over on a 5xx", async () => {
    const status = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: {} }) };
    const { f, calls } = fake({ a: [() => new Response("bad", { status: 502 })], b: [ok] });
    expect((await failover(["a", "b"], f).fetch("a", status)).status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["a", "b"]);
  });

  it("when every endpoint refuses, the last refusal comes back", async () => {
    expect((await failover(["a", "b"], fake({ a: [busy], b: [busy] }).f).fetch("a", read)).status).toBe(429);
    await expect(failover(["x"], fake({}).f).fetch("x", read)).rejects.toThrow("fetch failed");
  });

  it("a caller's own abort doesn't cool the endpoint down", async () => {
    const ac = new AbortController();
    ac.abort();
    const f = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const rpc = failover(["a", "b"], f);
    await expect(rpc.fetch("a", { ...read, signal: ac.signal })).rejects.toThrow("aborted");
    expect(rpc.cooling()).toEqual([]);
  });

  it("reads and transactions both get a finite timeout", async () => {
    const { f, calls } = fake({ a: [ok, ok] });
    const rpc = failover(["a"], f);
    await rpc.fetch("a", read);
    await rpc.fetch("a", send);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("the patched fetch routes only POSTs to known endpoints; everything else passes through", async () => {
    const seen: string[] = [];
    const base = (async (input: RequestInfo | URL) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : `Request:${input.url}`);
      return ok();
    }) as unknown as typeof fetch;
    const viaFailover: string[] = [];
    const f = { fetch: async (u: string) => (viaFailover.push(u), ok()), cooling: () => [] };
    const patched = routed([{ urls: ["https://rpc.example"], f }], base);
    await patched("https://rpc.example/", read); // trailing slash still matches
    await patched(new URL("https://rpc.example"), read);
    await patched("https://rpc.example", { method: "GET" });
    await patched("https://cloud-api.near.ai/v1/chat", read);
    await patched(new Request("https://rpc.example", { method: "POST", body: "{}" }));
    expect(viaFailover).toEqual(["https://rpc.example/", "https://rpc.example/"]);
    expect(seen).toEqual(["https://rpc.example", "https://cloud-api.near.ai/v1/chat", "Request:https://rpc.example/"]);
  });
});
