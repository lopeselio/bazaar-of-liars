/**
 * Haggle orchestrator for the web game.
 *
 *   GET  /api/merchants                 the stalls
 *   GET  /api/player?id=guest-…         coins + goods (from the bazaar contract) and the market day
 *   GET  /api/leaderboard               richest traders (peak purse), from the contract
 *   POST /api/haggle {merchantId,player,side} attest the model, roll + commit the secret onchain
 *   POST /api/haggle/:id/turn {text}    one turn; when the haggle ends the response carries the reveal
 *   POST /api/day/next {player}         after sundown, start the next market day
 *
 * State: live haggles, market days and rate limits sit in a Store (store.ts): Redis when
 * REDIS_URL is set, so any number of replicas can serve the same haggle; memory otherwise.
 * When a haggle ends it's revealed onchain, the proof bundle is handed to the player, and its
 * record is deleted. In production this also serves apps/web/dist.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { randomInt } from "node:crypto";
import { GOODS, MERCHANTS, type Side } from "@bazaar/core";
import { storeFromEnv, type DayRecord, type LiveRecord } from "./store.js";
import {
  HaggleSession,
  NearAiClient,
  claims,
  explorerTx,
  readLeaderboard,
  readMemory,
  ledgerFromEnv,
  nearAiAttestor,
  readPlayer,
  verifyBundle,
  type Ledger,
} from "@bazaar/merchant";

const PORT = Number(process.env.PORT ?? 8787);
const KEY = process.env.NEARAI_API_KEY;
const MODEL = process.env.NEARAI_MODEL;
if (!KEY || !MODEL) {
  console.error("✗ Set NEARAI_API_KEY and NEARAI_MODEL in .env");
  process.exit(1);
}
const ledger: Ledger | null = ledgerFromEnv();
if (!ledger) console.warn("⚠ BAZAAR_CONTRACT_ID / SERVER_ACCOUNT_ID unset: haggles stay offchain and players have no balance");

const STARTER_COINS = 200; // matches contracts/bazaar STARTER_COINS
const IDLE_MS = 10 * 60_000;
const MAX_TURNS = 25;
const MAX_TEXT = 300;
const HAGGLES_PER_IP_PER_HOUR = 30;
const HAGGLES_PER_DAY = 6;
/** Longest a turn can hold its lock: two model calls, each with a 20 s timeout and one retry. */
const TURN_LOCK_MS = 120_000;
/** Safety net: the idle sweep normally reveals a haggle long before its record expires. */
const LIVE_TTL_MS = 3 * IDLE_MS;
const DAY_TTL_MS = 30 * 24 * 3_600_000;
const GOOD_IDS = Object.keys(GOODS);
const PLAYER_RE = /^guest-[0-9a-f]{8,16}$/;

const llm = new NearAiClient(KEY);
const attestor = nearAiAttestor(KEY);

const store = await storeFromEnv();
console.log(`state store: ${store.kind}`);
const restore = (rec: LiveRecord) => HaggleSession.restore(rec.snap, llm, attestor, ledger ?? undefined);

// ---------- helpers ----------

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new HttpError(413, "request too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

async function rateLimit(ip: string) {
  if (!(await store.hit(`open:${ip}`, 3_600_000, HAGGLES_PER_IP_PER_HOUR)))
    throw new HttpError(429, "Too many haggles this hour. The merchants need a rest.");
}

/** Runs fn while holding the haggle's lock, so two replicas never play the same turn. */
async function withLock<T>(id: string, fn: () => Promise<T>, busy = "The merchant is still talking."): Promise<T> {
  const token = await store.lock(id, TURN_LOCK_MS);
  if (!token) throw new HttpError(409, busy);
  try {
    return await fn();
  } finally {
    await store.unlock(id, token);
  }
}

async function purse(player: string) {
  if (!ledger) return { id: player, coins: STARTER_COINS, known: false, goods: {} as Record<string, number>, onchain: false };
  const st = await readPlayer(ledger.network, ledger.contractId, player, GOOD_IDS);
  return {
    id: player,
    known: st.known,
    coins: st.known ? st.coins : STARTER_COINS,
    goods: Object.fromEntries(GOOD_IDS.map((g, i) => [g, st.goods[i] ?? 0])),
    onchain: true,
    network: ledger.network,
    contractId: ledger.contractId,
  };
}
/** Coins plus goods at their base value: what a day's profit is measured in. */
const worth = (p: { coins: number; goods: Record<string, number> }) =>
  p.coins + Object.entries(p.goods).reduce((s, [g, n]) => s + n * (GOODS[g]?.baseValue ?? 0), 0);

/** The player's market day, starting day 1 on first sight. */
async function dayOf(player: string, w: number): Promise<DayRecord> {
  const d = await store.getDay(player);
  if (d) return d;
  const fresh = { n: 1, left: HAGGLES_PER_DAY, startWorth: w };
  await store.putDay(player, fresh, DAY_TTL_MS);
  return fresh;
}

async function playerView(player: string) {
  const p = await purse(player);
  const w = worth(p);
  return { ...p, worth: w, day: { ...(await dayOf(player, w)), perDay: HAGGLES_PER_DAY } };
}

async function nextDay(body: Record<string, unknown>) {
  const player = String(body.player ?? "");
  if (!PLAYER_RE.test(player)) throw new HttpError(400, "player must look like guest-<hex>");
  const p = await purse(player);
  const d = await dayOf(player, worth(p));
  if (d.left > 0) throw new HttpError(409, `The sun is still up: ${d.left} haggle${d.left === 1 ? "" : "s"} left today.`);
  const next = { n: d.n + 1, left: HAGGLES_PER_DAY, startWorth: worth(p) };
  await store.putDay(player, next, DAY_TTL_MS);
  return { ...p, worth: next.startWorth, day: { ...next, perDay: HAGGLES_PER_DAY } };
}

/** Close onchain, build + verify the bundle, count the haggle against the day, forget it. Call under the lock. */
async function finish(id: string, l: LiveRecord, session = restore(l)) {
  await store.deleteLive(id);
  await store.clearActive(l.player, id);
  const d = await store.getDay(l.player);
  const day = d ? { ...d, left: Math.max(0, d.left - 1) } : null;
  if (day) await store.putDay(l.player, day, DAY_TTL_MS);
  const chain = await session.close();
  const bundle = await session.bundle();
  const checks = await verifyBundle(bundle);
  const secret = bundle.reveal.secret;
  // Every claim, whether it was true, and whether the player called it.
  const claimList: { turn: number; claimed: number; truth: boolean; said: string; called?: "caught" | "honest" }[] = [];
  const calls: { turn: number; result: "caught" | "honest" }[] = [];
  bundle.turns.forEach((t, i) => {
    const d = t.decision;
    if (d?.call) {
      calls.push({ turn: i + 1, result: d.call });
      const target = claimList.at(-1);
      if (target && !target.called) target.called = d.call;
    }
    if (d && claims(d)) {
      // A merchant restating the same live claim isn't a new claim.
      const prev = claimList.at(-1);
      if (!(prev && !prev.called && prev.claimed === d.statedFloor)) {
        claimList.push({ turn: i + 1, claimed: d.statedFloor!, truth: d.statedFloor === secret.floor, said: t.display });
      }
    }
  });
  // What each tell meant: how far the merchant really was from its limit.
  const tells = bundle.turns.flatMap((t, i) =>
    t.decision && t.decision.action !== "accept" && t.decision.action !== "walk"
      ? [{ turn: i + 1, tell: t.decision.tell, gap: Math.abs(t.decision.price - secret.floor) }]
      : [],
  );
  return {
    status: bundle.outcome.status,
    dealPrice: bundle.outcome.dealPrice,
    leftOnTable: bundle.outcome.leftOnTable,
    side: secret.side,
    secret: { floor: secret.floor, need: secret.need, listPrice: secret.listPrice, grudge: secret.grudge, loyalty: secret.loyalty },
    claims: claimList,
    calls,
    tells,
    chain: chain && {
      contractId: chain.contractId,
      network: chain.network,
      openTx: chain.openTx,
      openTxUrl: explorerTx(chain.network, chain.openTx),
      closeTx: chain.closeTx,
      closeTxUrl: chain.closeTx ? explorerTx(chain.network, chain.closeTx) : null,
      closeError: chain.closeError ?? null,
    },
    checks: checks.map(({ id, label, ok, detail }) => ({ id, label, ok, detail })),
    day: day && { ...day, perDay: HAGGLES_PER_DAY },
    bundle,
  };
}

// Idle haggles are revealed (no deal) and dropped. Every replica sweeps; the lock makes it once.
setInterval(async () => {
  try {
    for (const id of await store.idleIds(Date.now() - IDLE_MS)) {
      const token = await store.lock(id, TURN_LOCK_MS);
      if (!token) continue;
      try {
        const l = await store.getLive(id);
        if (!l) await store.deleteLive(id);
        else if (Date.now() - l.lastActive > IDLE_MS) await finish(id, l);
      } catch (e) {
        console.error("idle close failed", e);
      } finally {
        await store.unlock(id, token);
      }
    }
  } catch (e) {
    console.error("idle sweep failed", e);
  }
}, 60_000).unref();

// ---------- routes ----------

async function openHaggle(body: Record<string, unknown>, ip: string) {
  const merchant = MERCHANTS.find((m) => m.id === body.merchantId);
  const player = String(body.player ?? "");
  const side: Side = body.side === "buy" ? "buy" : "sell";
  if (!merchant) throw new HttpError(400, "unknown merchant");
  if (!PLAYER_RE.test(player)) throw new HttpError(400, "player must look like guest-<hex>");
  await rateLimit(ip);

  // One haggle per player at a time, so two tabs can't overspend the same coins.
  const prev = await store.getActive(player);
  if (prev)
    await withLock(
      prev,
      async () => {
        const l = await store.getLive(prev);
        if (l) await finish(prev, l);
        else await store.clearActive(player, prev);
      },
      "Your other haggle is mid-sentence. Wait for the merchant, then try again.",
    );

  const me = await playerView(player);
  if (me.day.left <= 0) throw new HttpError(409, "The sun has set on this market day. Start the next day to keep trading.");
  const goodId = side === "sell" ? merchant.goodId : merchant.buysGoodId;
  if (side === "sell" && me.coins <= 0) throw new HttpError(402, "Your purse is empty.");
  if (side === "buy" && !(me.goods[goodId] > 0)) throw new HttpError(400, `You have no ${GOODS[goodId].name} to sell.`);
  const memory = ledger ? await readMemory(ledger.network, ledger.contractId, player, merchant.id) : { lowballs: 0, deals: 0 };

  const t0 = Date.now();
  const session = new HaggleSession(
    llm,
    attestor,
    MODEL!,
    merchant,
    randomInt(2 ** 31),
    ledger ? { ledger, player } : undefined,
    side,
    memory,
  );
  let opened;
  try {
    opened = await session.open();
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("attestation failed")) {
      console.warn(msg);
      throw new HttpError(503, "The merchant's AI enclave failed verification, so this haggle won't start. Try again in a moment.");
    }
    throw e;
  }
  await store.putLive({ snap: session.snapshot(), player, budget: me.coins, lastActive: Date.now(), turns: 0 }, LIVE_TTL_MS);
  await store.setActive(player, session.id, LIVE_TTL_MS);

  const cand = opened.verification.candidates.find((c) => c.ok) ?? opened.verification.candidates[0];
  return {
    haggleId: session.id,
    merchant: { id: merchant.id, name: merchant.name },
    side,
    good: session.good,
    memory: { lowballs: memory.lowballs, deals: memory.deals, grudge: session.grudge, loyalty: session.loyalty },
    commitment: opened.commitment,
    openingAsk: opened.openingAsk,
    budget: me.coins,
    day: me.day,
    openTx: opened.openTx,
    openTxUrl: opened.openTx && ledger ? explorerTx(ledger.network, opened.openTx) : null,
    attestation: {
      model: MODEL,
      nonce: opened.verification.nonce,
      verifiedAt: opened.verification.verifiedAt,
      signers: opened.verification.trustedSigners,
      checks: (cand?.checks ?? []).map(({ id, label, ok, detail }) => ({ id, label, ok, detail })),
    },
    ms: Date.now() - t0,
  };
}

async function turn(id: string, body: Record<string, unknown>) {
  const text = String(body.text ?? "").trim().slice(0, MAX_TEXT);
  if (!text) throw new HttpError(400, "say something");
  if (!(await store.getLive(id))) throw new HttpError(404, "This haggle is over (or never existed).");

  return withLock(id, async () => {
    // Re-read under the lock: another replica may have just played a turn or closed it.
    const l = await store.getLive(id);
    if (!l) throw new HttpError(404, "This haggle is over (or never existed).");
    const session = restore(l);
    const t0 = Date.now();
    // Out of turns: walk the player out.
    const r = await session.turn(++l.turns > MAX_TURNS ? "leave" : text, l.budget);
    const out: Record<string, unknown> = {
      text: r.text,
      action: r.decision?.action ?? (r.move.kind === "leave" ? "left" : null),
      price: r.decision?.price ?? null,
      tell: r.decision?.tell ?? null,
      status: r.status,
      ask: session.status === "open" || session.status === "deal" ? session.ask : null,
      refused: r.refused ?? null,
      claim: session.claim ?? null,
      call: r.decision?.call ?? null,
      ms: Date.now() - t0,
    };
    if (r.refused) l.turns--;
    l.lastActive = Date.now();
    if (session.status !== "open") out.end = await finish(id, l, session);
    else await store.putLive({ ...l, snap: session.snapshot() }, LIVE_TTL_MS);
    return out;
  });
}

// ---------- static (production) ----------

const WEB_DIST = resolve(import.meta.dirname, "../../web/dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};
function serveStatic(url: string, res: ServerResponse): boolean {
  if (!existsSync(WEB_DIST)) return false;
  const rel = normalize(decodeURIComponent(url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  let file = join(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
  return true;
}

// ---------- server ----------

createServer(async (req, res) => {
  const url = req.url ?? "/";
  // Behind a hosting proxy the real client is the last X-Forwarded-For hop (the first is client-supplied).
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",").pop()?.trim() || req.socket.remoteAddress || "?";
  try {
    if (req.method === "GET" && url === "/api/merchants")
      return send(res, 200, {
        merchants: MERCHANTS.map((m) => ({ id: m.id, name: m.name, good: GOODS[m.goodId], buys: GOODS[m.buysGoodId] })),
        model: MODEL,
        onchain: ledger ? { network: ledger.network, contractId: ledger.contractId } : null,
      });
    if (req.method === "GET" && url.startsWith("/api/player")) {
      const id = new URL(url, "http://x").searchParams.get("id") ?? "";
      if (!PLAYER_RE.test(id)) throw new HttpError(400, "bad player id");
      return send(res, 200, await playerView(id));
    }
    if (req.method === "GET" && url === "/api/leaderboard")
      return send(res, 200, { leaders: ledger ? await readLeaderboard(ledger.network, ledger.contractId) : [] });
    if (req.method === "POST" && url === "/api/haggle") return send(res, 200, await openHaggle(await readJson(req), ip));
    if (req.method === "POST" && url === "/api/day/next") return send(res, 200, await nextDay(await readJson(req)));
    const m = url.match(/^\/api\/haggle\/([0-9a-f-]{36})\/turn$/);
    if (req.method === "POST" && m) return send(res, 200, await turn(m[1], await readJson(req)));
    if (url.startsWith("/api/")) throw new HttpError(404, "not found");
    if (req.method === "GET" && serveStatic(url, res)) return;
    throw new HttpError(404, "not found");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: status === 500 ? "The bazaar hit a snag. Try again." : (e as Error).message });
  }
}).listen(PORT, () => {
  console.log(`bazaar server on http://localhost:${PORT}  (model ${MODEL}${ledger ? `, contract ${ledger.contractId}` : ", offchain"})`);
});
