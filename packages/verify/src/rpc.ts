/**
 * RPC failover. The free public RPCs answer HTTP 429 when busy, so the server never relies on
 * one endpoint. Endpoints come from docs.near.org/api/rpc/providers (free, no key);
 * NEAR_RPC_URL (comma-separated) puts your own first, for the network in NEAR_NETWORK.
 *
 * Reads: a refusal (408, 429, 5xx) or no answer sends the same request to the next endpoint.
 *
 * Transactions fail over only on 429: the node turned the request away at the door, so it never
 * reached the chain. A 5xx, a timeout or a dropped connection is ambiguous (the transaction may
 * already be in a block), so it goes back to near-kit unchanged, which retries the same signed
 * transaction on the same endpoint as it always has. Failing over then could meet a node that
 * hasn't seen the block yet, answer "invalid nonce", and have near-kit sign it a second time.
 *
 * An endpoint that refused is skipped for a short cool-down, so a rate-limited node isn't hit
 * again on the very next call.
 */
export type Network = "testnet" | "mainnet";

const PUBLIC: Record<Network, string[]> = {
  testnet: ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs"],
  mainnet: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://rpc.intea.rs"],
};

/**
 * Archival endpoints, for history a regular node has pruned (a transaction or block older than
 * a few days). FastNEAR's answers today; NEAR's own is listed on docs.near.org but rate limited.
 */
const ARCHIVAL: Record<Network, string[]> = {
  testnet: ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"],
  mainnet: ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"],
};
export const archivalRpcUrls = (network: Network) => ARCHIVAL[network];

/** fetch as it was before installRpcFailover, so a failover never wraps another. */
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

const COOL_DOWN_MS = 30_000;
const READ_TIMEOUT_MS = 10_000;
/** Long enough for a FINAL wait on an MPC signature; shorter than the server's tick locks (60 s). */
const TX_TIMEOUT_MS = 50_000;

const norm = (u: string) => u.trim().replace(/\/+$/, "");

/** The endpoints for a network: yours first (NEAR_RPC_URL, for NEAR_NETWORK), then the public ones. */
// Node has process.env; a browser doesn't (there it's just the public endpoints).
const defaultEnv = (): { NEAR_RPC_URL?: string; NEAR_NETWORK?: string } => (typeof process !== "undefined" && process.env ? (process.env as Record<string, string | undefined>) : {});

export function rpcUrls(network: Network, env: { NEAR_RPC_URL?: string; NEAR_NETWORK?: string } = defaultEnv()): string[] {
  const forThis = (env.NEAR_NETWORK ?? "testnet") === network;
  const own = forThis ? (env.NEAR_RPC_URL ?? "").split(",").map(norm).filter(Boolean) : [];
  return [...new Set([...own, ...PUBLIC[network]])];
}

/** The URL handed to near-kit: requests to it go through the failover. */
export const primaryRpc = (network: Network) => rpcUrls(network)[0]!;

const refused = (status: number) => status === 408 || status === 429 || status >= 500;

/** Methods that put a transaction on the chain: failover only on 429. */
const isTxMethod = (body: unknown) => typeof body === "string" && /"method"\s*:\s*"(send_tx|broadcast_tx_commit|broadcast_tx_async)"/.test(body);
/** Status queries for a transaction: reads (safe on any node) that may wait on the chain. */
const isTxStatus = (body: unknown) => typeof body === "string" && /"method"\s*:\s*"(tx|EXPERIMENTAL_tx_status)"/.test(body);

const discard = (r: Response | Error | null) => {
  if (r instanceof Response) r.body?.cancel().catch(() => {});
};

export interface Failover {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Endpoints currently cooling down (for tests and logs). */
  cooling(): string[];
}

/** A fetch that tries each endpoint of `urls` in turn (healthy ones first). */
export function failover(urls: string[], base: typeof fetch = nativeFetch, now: () => number = Date.now): Failover {
  const coolUntil = new Map<string, number>();
  const cool = (u: string) => coolUntil.set(u, now() + COOL_DOWN_MS);
  const order = () => {
    const t = now();
    return [...urls.filter((u) => (coolUntil.get(u) ?? 0) <= t), ...urls.filter((u) => (coolUntil.get(u) ?? 0) > t)];
  };
  return {
    cooling: () => urls.filter((u) => (coolUntil.get(u) ?? 0) > now()),
    async fetch(_url, init) {
      const tx = isTxMethod(init.body);
      let last: Response | Error | null = null;
      for (const u of order()) {
        let res: Response;
        try {
          res = await base(u, { ...init, signal: init.signal ?? AbortSignal.timeout(tx || isTxStatus(init.body) ? TX_TIMEOUT_MS : READ_TIMEOUT_MS) });
        } catch (e) {
          if (init.signal?.aborted) throw e; // the caller gave up: not the endpoint's fault
          cool(u);
          if (tx) throw e; // ambiguous for a transaction: near-kit retries it as before
          discard(last);
          last = e as Error;
          continue;
        }
        if (!refused(res.status)) {
          discard(last);
          return res;
        }
        cool(u);
        if (tx && res.status !== 429) return res; // ambiguous: leave it to near-kit
        discard(last);
        last = res;
      }
      if (last instanceof Response) return last;
      throw last ?? new Error("no RPC endpoint");
    },
  };
}

let installed = false;

/**
 * Route every POST to a known NEAR RPC endpoint through the failover. near-kit calls the
 * global fetch with the URL it was given, so this covers all of its reads and transactions.
 * Other fetches (NEAR AI, Auth0, nearblocks, a Request object) pass through untouched.
 */
export function installRpcFailover(): void {
  if (installed) return;
  installed = true;
  const lists = (Object.keys(PUBLIC) as Network[]).map((n) => ({ urls: rpcUrls(n), f: failover(rpcUrls(n)) }));
  globalThis.fetch = routed(lists, nativeFetch);
}

/** The patched fetch (exported for tests). */
export function routed(lists: Array<{ urls: string[]; f: Failover }>, base: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
    const hit = url !== null && init?.method?.toUpperCase() === "POST" ? lists.find((l) => l.urls.includes(norm(url))) : undefined;
    return hit ? hit.f.fetch(url!, init!) : base(input, init);
  }) as typeof fetch;
}
