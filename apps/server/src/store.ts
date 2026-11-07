/**
 * Where live haggles, market days and rate limits are kept.
 *
 * With REDIS_URL set (the hosted demo uses Azure Managed Redis), every replica shares one store:
 * any replica can serve the next turn, and a restart doesn't drop a haggle in progress.
 * Without it, an in-memory store does the same job for one process (local dev, tests).
 *
 * A live haggle's record holds its secret and salt until the haggle is revealed onchain, then it's
 * deleted. Redis is configured without persistence, so those secrets are never written to disk.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import type { SessionSnapshot } from "@bazaar/merchant";

export interface LiveRecord {
  snap: SessionSnapshot;
  player: string;
  /** The player's coins when the haggle opened (purchases above this are refused). */
  budget: number;
  lastActive: number;
  turns: number;
}

/** A market day: a fixed number of haggles, then sundown. */
export interface DayRecord {
  n: number;
  left: number;
  /** Purse + goods at the start of the day, for the sundown profit. */
  startWorth: number;
}

export interface Store {
  readonly kind: "memory" | "redis";
  getLive(id: string): Promise<LiveRecord | null>;
  /** Saves the record and indexes it by lastActive for the idle sweep. */
  putLive(rec: LiveRecord, ttlMs: number): Promise<void>;
  deleteLive(id: string): Promise<void>;
  /** Live haggles not touched since `before` (epoch ms). */
  idleIds(before: number): Promise<string[]>;
  /** Exclusive lock on one haggle across replicas. Returns a token, or null if someone holds it. */
  lock(id: string, ttlMs: number): Promise<string | null>;
  unlock(id: string, token: string): Promise<void>;
  getActive(player: string): Promise<string | null>;
  setActive(player: string, id: string, ttlMs: number): Promise<void>;
  /** Clears the player's active haggle only if it's still `id`. */
  clearActive(player: string, id: string): Promise<void>;
  /** Counts one hit in a fixed window; false once `limit` is exceeded. */
  hit(key: string, windowMs: number, limit: number): Promise<boolean>;
  getDay(player: string): Promise<DayRecord | null>;
  putDay(player: string, day: DayRecord, ttlMs: number): Promise<void>;
  /** Newest-first feed of what happened on the street, capped at `max`. */
  pushNews(item: NewsItem, max?: number): Promise<void>;
  news(n: number): Promise<NewsItem[]>;
  /** A counter that forgets after `ttlMs` of no hits (recent demand). */
  bump(key: string, ttlMs: number): Promise<number>;
  count(key: string): Promise<number>;
  /** Small JSON records (a player's delivery job, say), expiring after `ttlMs`. */
  getJSON<T>(key: string): Promise<T | null>;
  putJSON(key: string, value: unknown, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  close(): Promise<void>;
}

/** One line in the street's news feed. */
export interface NewsItem {
  t: number;
  kind: "sale" | "restock" | "hire" | "trade" | "consume" | "invest" | "closed" | "order" | "delivery" | "stall" | "auction" | "rumour";
  text: string;
  /** Explorer link for the transaction that settled it. */
  tx?: string;
  agents: string[];
}

// ---------- in-memory (one process) ----------

export function memoryStore(): Store {
  const live = new Map<string, string>();
  const lastActive = new Map<string, number>();
  const locks = new Map<string, { token: string; until: number }>();
  const active = new Map<string, string>();
  const hits = new Map<string, { n: number; until: number }>();
  const days = new Map<string, string>();
  let feed: NewsItem[] = [];
  const counters = new Map<string, { n: number; until: number }>();
  const kv = new Map<string, { v: string; until: number }>();
  return {
    kind: "memory",
    async getJSON<T>(key: string) {
      const e = kv.get(key);
      return e && e.until > Date.now() ? (JSON.parse(e.v) as T) : null;
    },
    async putJSON(key, value, ttlMs) {
      kv.set(key, { v: JSON.stringify(value), until: Date.now() + ttlMs });
    },
    async del(key) {
      kv.delete(key);
    },
    async pushNews(item, max = 50) {
      feed = [item, ...feed].slice(0, max);
    },
    async news(n) {
      return feed.slice(0, n);
    },
    async bump(key, ttlMs) {
      const now = Date.now();
      const c = counters.get(key);
      const n = c && c.until > now ? c.n + 1 : 1;
      counters.set(key, { n, until: now + ttlMs });
      return n;
    },
    async count(key) {
      const c = counters.get(key);
      return c && c.until > Date.now() ? c.n : 0;
    },
    async getLive(id) {
      const raw = live.get(id);
      return raw ? JSON.parse(raw) : null;
    },
    async putLive(rec) {
      // Stored as JSON so behaviour matches Redis: nothing shares object identity across turns.
      live.set(rec.snap.id, JSON.stringify(rec));
      lastActive.set(rec.snap.id, rec.lastActive);
    },
    async deleteLive(id) {
      live.delete(id);
      lastActive.delete(id);
    },
    async idleIds(before) {
      return [...lastActive].filter(([, t]) => t < before).map(([id]) => id);
    },
    async lock(id, ttlMs) {
      const now = Date.now();
      const held = locks.get(id);
      if (held && held.until > now) return null;
      const token = randomUUID();
      locks.set(id, { token, until: now + ttlMs });
      return token;
    },
    async unlock(id, token) {
      if (locks.get(id)?.token === token) locks.delete(id);
    },
    async getActive(player) {
      return active.get(player) ?? null;
    },
    async setActive(player, id) {
      active.set(player, id);
    },
    async clearActive(player, id) {
      if (active.get(player) === id) active.delete(player);
    },
    async hit(key, windowMs, limit) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || h.until <= now) {
        hits.set(key, { n: 1, until: now + windowMs });
        return 1 <= limit;
      }
      h.n++;
      return h.n <= limit;
    },
    async getDay(player) {
      const raw = days.get(player);
      return raw ? JSON.parse(raw) : null;
    },
    async putDay(player, day) {
      days.set(player, JSON.stringify(day));
    },
    async close() {},
  };
}

// ---------- Redis (shared by every replica) ----------

const UNLOCK_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * `prefix` carries a {hash tag} so every key lands in one slot: Azure Managed Redis is clustered,
 * and a MULTI across slots (the live record + its activity index) is refused. One slot is plenty here.
 */
export async function redisStore(url: string, prefix = "{bazaar}:"): Promise<Store> {
  const client = createClient({ url, socket: { reconnectStrategy: (n) => Math.min(n * 200, 5000) } });
  client.on("error", (e) => console.error("redis:", (e as Error).message));
  await client.connect();
  const k = (...parts: string[]) => prefix + parts.join(":");
  const IDLE_INDEX = k("live-by-activity");
  return {
    kind: "redis",
    async getLive(id) {
      const raw = await client.get(k("live", id));
      return raw ? JSON.parse(raw) : null;
    },
    async putLive(rec, ttlMs) {
      await client
        .multi()
        .set(k("live", rec.snap.id), JSON.stringify(rec), { expiration: { type: "PX", value: ttlMs } })
        .zAdd(IDLE_INDEX, { score: rec.lastActive, value: rec.snap.id })
        .exec();
    },
    async deleteLive(id) {
      await client.multi().del(k("live", id)).zRem(IDLE_INDEX, id).exec();
    },
    async idleIds(before) {
      return client.zRangeByScore(IDLE_INDEX, "-inf", `(${before}`);
    },
    async lock(id, ttlMs) {
      const token = randomUUID();
      const ok = await client.set(k("lock", id), token, { condition: "NX", expiration: { type: "PX", value: ttlMs } });
      return ok === "OK" ? token : null;
    },
    async unlock(id, token) {
      await client.eval(UNLOCK_LUA, { keys: [k("lock", id)], arguments: [token] });
    },
    async getActive(player) {
      return client.get(k("active", player));
    },
    async setActive(player, id, ttlMs) {
      await client.set(k("active", player), id, { expiration: { type: "PX", value: ttlMs } });
    },
    async clearActive(player, id) {
      await client.eval(UNLOCK_LUA, { keys: [k("active", player)], arguments: [id] });
    },
    async hit(key, windowMs, limit) {
      const bucket = k("rl", key, String(Math.floor(Date.now() / windowMs)));
      const [n] = (await client.multi().incr(bucket).pExpire(bucket, windowMs).exec()) as unknown as [number];
      return Number(n) <= limit;
    },
    async getDay(player) {
      const raw = await client.get(k("day", player));
      return raw ? JSON.parse(raw) : null;
    },
    async putDay(player, day, ttlMs) {
      await client.set(k("day", player), JSON.stringify(day), { expiration: { type: "PX", value: ttlMs } });
    },
    async pushNews(item, max = 50) {
      await client.multi().lPush(k("news"), JSON.stringify(item)).lTrim(k("news"), 0, max - 1).exec();
    },
    async news(n) {
      return (await client.lRange(k("news"), 0, n - 1)).map((x) => JSON.parse(x));
    },
    async bump(key, ttlMs) {
      const [n] = (await client.multi().incr(k("n", key)).pExpire(k("n", key), ttlMs).exec()) as unknown as [number];
      return Number(n);
    },
    async count(key) {
      return Number((await client.get(k("n", key))) ?? 0);
    },
    async getJSON<T>(key: string) {
      const raw = await client.get(k("kv", key));
      return raw ? (JSON.parse(raw) as T) : null;
    },
    async putJSON(key, value, ttlMs) {
      await client.set(k("kv", key), JSON.stringify(value), { expiration: { type: "PX", value: ttlMs } });
    },
    async del(key) {
      await client.del(k("kv", key));
    },
    async close() {
      await client.quit();
    },
  };
}

export const storeFromEnv = (env = process.env): Promise<Store> =>
  env.REDIS_URL ? redisStore(env.REDIS_URL) : Promise.resolve(memoryStore());
