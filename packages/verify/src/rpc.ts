/**
 * RPC failover. The free public RPCs answer HTTP 429 when busy, so the server never relies on
 * one: a request the first endpoint refuses (429, 408, 5xx, or no answer) is sent unchanged to the
 * next. Resending a signed transaction is safe: it has one hash and one nonce, so NEAR runs it at
 * most once however many nodes receive it.
 *
 * An endpoint that refused is skipped for a short cool-down, so a rate-limited node isn't hit
 * again on the very next call. Endpoints come from docs.near.org/api/rpc/providers (free, no key).
 * NEAR_RPC_URL (comma-separated) puts your own endpoints first.
 */
export type Network = "testnet" | "mainnet";

const PUBLIC: Record<Network, string[]> = {
  testnet: ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs"],
  mainnet: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://rpc.intea.rs"],
};

/** fetch as it was before installRpcFailover, so a failover never wraps another. */
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

const COOL_DOWN_MS = 30_000;
const READ_TIMEOUT_MS = 10_000;

/** The endpoints for a network, your own (NEAR_RPC_URL) first. */
export function rpcUrls(network: Network, env: string | undefined = process.env.NEAR_RPC_URL): string[] {
  const own = (env ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...own, ...PUBLIC[network]])];
}

/** The URL handed to near-kit: requests to it go through the failover. */
export const primaryRpc = (network: Network) => rpcUrls(network)[0]!;

const refused = (status: number) => status === 408 || status === 429 || status >= 500;

/** Methods that wait on the chain (a transaction): no client timeout, the node decides. */
const isTxMethod = (body: unknown) => typeof body === "string" && /"method"\s*:\s*"(send_tx|broadcast_tx_commit|broadcast_tx_async|tx|EXPERIMENTAL_tx_status)"/.test(body);

export interface Failover {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Endpoints currently cooling down (for tests and logs). */
  cooling(): string[];
}

/** A fetch that tries each endpoint of `urls` in turn (healthy ones first). */
export function failover(urls: string[], base: typeof fetch = nativeFetch, now: () => number = Date.now): Failover {
  const coolUntil = new Map<string, number>();
  const order = () => {
    const t = now();
    const ok = urls.filter((u) => (coolUntil.get(u) ?? 0) <= t);
    const cooling = urls.filter((u) => (coolUntil.get(u) ?? 0) > t);
    return [...ok, ...cooling];
  };
  return {
    cooling: () => urls.filter((u) => (coolUntil.get(u) ?? 0) > now()),
    async fetch(_url, init) {
      const tx = isTxMethod(init.body);
      let last: Response | Error | null = null;
      for (const u of order()) {
        try {
          const res = await base(u, tx ? init : { ...init, signal: init.signal ?? AbortSignal.timeout(READ_TIMEOUT_MS) });
          if (!refused(res.status)) return res;
          if (last instanceof Response) await last.body?.cancel().catch(() => {});
          last = res;
        } catch (e) {
          last = e as Error;
        }
        coolUntil.set(u, now() + COOL_DOWN_MS);
      }
      if (last instanceof Response) return last;
      throw last ?? new Error("no RPC endpoint");
    },
  };
}

let installed = false;

/**
 * Route every fetch to a known NEAR RPC endpoint through the failover. near-kit calls the
 * global fetch with the URL it was given, so this covers all of its reads and transactions.
 * Other fetches pass through untouched.
 */
export function installRpcFailover(): void {
  if (installed) return;
  installed = true;
  const lists = (Object.keys(PUBLIC) as Network[]).map((n) => ({ urls: rpcUrls(n), f: failover(rpcUrls(n)) }));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const hit = typeof input === "string" || input instanceof URL ? lists.find((l) => l.urls.includes(url.replace(/\/$/, ""))) : undefined;
    if (hit && init?.method === "POST") return hit.f.fetch(url, init);
    return nativeFetch(input, init);
  }) as typeof fetch;
}
