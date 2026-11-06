/**
 * Haggle orchestrator for the web game.
 *
 *   GET  /api/merchants                 the stalls
 *   GET  /api/player?id=guest-…         coins + goods (from the bazaar contract) and the market day
 *   GET  /api/leaderboard               richest traders (peak purse), from the contract
 *   POST /api/haggle {merchantId,player,side} attest the model, roll + commit the secret onchain
 *   POST /api/haggle/:id/turn {text}    one turn; when the haggle ends the response carries the reveal
 *   POST /api/day/next {player}         after sundown, start the next market day
 *   GET  /api/market                    Canal Street's agents (purse, stock, policy) and the street news
 *   POST /api/invest {player,agentId,amount} put coins into an agent (say, a broke merchant)
 *   GET  /api/orders?player=guest-…     open delivery orders across Manhattan, and the player's job
 *   POST /api/orders/:id/take {player,x,z}   take a delivery job (one at a time)
 *   POST /api/orders/:id/deliver {player,x,z,mode}  hand it over at the drop site
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
import { AGENTS, CANAL_ORIGIN, GOODS, MERCHANTS, fare as fareFor, impliedMode, routeMetres, type Side, type TravelMode } from "@bazaar/core";
import { storeFromEnv, type DayRecord, type LiveRecord } from "./store.js";
import { Market } from "./market.js";
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
  agentSignersFromEnv,
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
// Canal Street's agent economy (contract v3): agents with their own accounts, purses and stock.
const signers = ledger ? agentSignersFromEnv(AGENTS.map((a) => a.id)) : null;
const market = ledger && signers ? new Market(ledger, signers, store) : null;
console.log(market ? "agent economy: on (v3)" : "agent economy: off");
const MARKET_TICK_MS = Number(process.env.MARKET_TICK_MS ?? 40_000);
if (market && MARKET_TICK_MS > 0)
  setInterval(async () => {
    // One replica at a time runs the agents.
    const token = await store.lock("market-tick", 5 * 60_000).catch(() => null);
    if (!token) return;
    try {
      await market.tick();
    } finally {
      await store.unlock("market-tick", token);
    }
  }, MARKET_TICK_MS).unref();

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

async function invest(body: Record<string, unknown>) {
  if (!market || !ledger?.invest) throw new HttpError(404, "investing needs the agent economy");
  const player = String(body.player ?? "");
  const agentId = String(body.agentId ?? "");
  const amount = Math.floor(Number(body.amount));
  if (!PLAYER_RE.test(player)) throw new HttpError(400, "player must look like guest-<hex>");
  if (!MERCHANTS.some((m) => m.id === agentId)) throw new HttpError(400, "you can only invest in a merchant");
  if (!(amount >= 5 && amount <= 500)) throw new HttpError(400, "invest between 5 and 500 coins");
  const p = await purse(player);
  if (p.coins < amount) throw new HttpError(402, `You only have ${p.coins} coins.`);
  const tx = await ledger.invest({ player, agentId, amount });
  market.invalidate();
  const name = MERCHANTS.find((m) => m.id === agentId)!.name;
  await store.pushNews({ t: Date.now(), kind: "invest", text: `A player invested ${amount} coins in ${name}`, tx: explorerTx(ledger.network, tx), agents: [agentId] });
  return { ok: true, txUrl: explorerTx(ledger.network, tx), player: await playerView(player) };
}

// ---------- delivery jobs ----------

interface Job {
  orderId: string;
  takenAt: number;
  from: { x: number; z: number };
}
const DROP_RADIUS_M = 45;
const MODE_RANK: Record<TravelMode, number> = { foot: 0, bike: 1, cab: 2, heli: 3 };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

async function listOrders(player: string) {
  if (!market) return { orders: [], job: null, now: Date.now() };
  const now = Date.now();
  const orders = (await market.orders()).filter((o) => o.status === "open" && o.deadline_ms > now);
  const job = PLAYER_RE.test(player) ? await store.getJSON<Job>(`job:${player}`) : null;
  return { orders, job: job && orders.some((o) => o.id === job.orderId) ? job : null, now };
}

async function takeOrder(id: string, body: Record<string, unknown>) {
  if (!market) throw new HttpError(404, "deliveries need the agent economy");
  const player = String(body.player ?? "");
  if (!PLAYER_RE.test(player)) throw new HttpError(400, "player must look like guest-<hex>");
  const x = num(body.x);
  const z = num(body.z);
  if (Number.isNaN(x) || Number.isNaN(z)) throw new HttpError(400, "where are you?");
  const o = (await market.orders(0)).find((x) => x.id === id);
  if (!o || o.status !== "open" || o.deadline_ms <= Date.now()) throw new HttpError(409, "That order is gone.");
  const job: Job = { orderId: id, takenAt: Date.now(), from: { x, z } };
  await store.putJSON(`job:${player}`, job, Math.max(60_000, o.deadline_ms - Date.now() + 60_000));
  return { job, order: o };
}

/**
 * The player says they're at the drop site. Positions come from the player's browser, so the
 * server checks what it can: they're within reach of the site, and the time since they took the
 * job fits the distance. The travel mode (and so the fare) comes from that average speed, not
 * from what the browser claims, unless the claim is the dearer one.
 */
async function deliverOrder(id: string, body: Record<string, unknown>) {
  if (!market || !ledger?.fulfilOrder) throw new HttpError(404, "deliveries need the agent economy");
  const player = String(body.player ?? "");
  if (!PLAYER_RE.test(player)) throw new HttpError(400, "player must look like guest-<hex>");
  const job = await store.getJSON<Job>(`job:${player}`);
  if (!job || job.orderId !== id) throw new HttpError(409, "Take the job first.");
  const o = (await market.orders(0)).find((x) => x.id === id);
  if (!o || o.status !== "open") throw new HttpError(409, "Someone else got there first.");
  if (o.deadline_ms <= Date.now()) throw new HttpError(409, `${o.customerName} stopped waiting.`);
  const x = num(body.x);
  const z = num(body.z);
  if (Math.hypot(x - o.x, z - o.z) > DROP_RADIUS_M) throw new HttpError(409, `You're not at ${o.siteName} yet.`);
  const me = await purse(player);
  if (!(me.goods[o.good_id] > 0)) throw new HttpError(409, `You don't have any ${o.goodName}. Buy one on Canal Street.`);

  // Two legs the server can time: from where the job was taken, and from the player's last haggle
  // on Canal Street. Both must be possible; the faster one sets the fare.
  const legs = [{ metres: routeMetres(job.from, o), ms: Date.now() - job.takenAt }];
  const canal = await store.getJSON<{ at: number }>(`canal:${player}`);
  if (canal && canal.at > job.takenAt - 30 * 60_000) legs.push({ metres: routeMetres(CANAL_ORIGIN, o), ms: Date.now() - canal.at });
  const modes = legs.map((l) => impliedMode(l.metres, l.ms));
  if (modes.some((m) => m === null)) throw new HttpError(409, "Nothing in this city gets there that fast.");
  const implied = (modes as TravelMode[]).reduce((a, b) => (MODE_RANK[b] > MODE_RANK[a] ? b : a));
  const metres = Math.max(...legs.map((l) => l.metres));
  const elapsed = Date.now() - job.takenAt;
  const claimed = (["foot", "bike", "cab", "heli"] as const).find((m) => m === body.mode);
  const mode = claimed && MODE_RANK[claimed] > MODE_RANK[implied] ? claimed : implied;
  const fare = Math.min(o.bounty, fareFor(mode, metres));
  const tx = await ledger.fulfilOrder({ orderId: id, player, fare });
  await store.del(`job:${player}`);
  await market.onDelivered(o, fare, mode, tx);
  return { bounty: o.bounty, fare, net: o.bounty - fare, mode, metres, seconds: Math.round(elapsed / 1000), msToSpare: o.deadline_ms - Date.now(), txUrl: explorerTx(ledger.network, tx), player: await playerView(player) };
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
  // The player was at a Canal Street stall just now: deliveries are timed from here too.
  await store.putJSON(`canal:${l.player}`, { at: Date.now() }, 24 * 3_600_000);
  const chain = await session.close();
  const bundle = await session.bundle();
  if (market && bundle.outcome.status === "deal" && bundle.outcome.dealPrice !== null)
    void market
      .onPlayerDeal(bundle.reveal.secret.merchantId, bundle.reveal.secret.side, bundle.reveal.secret.goodId, bundle.outcome.dealPrice, chain?.closeTx ?? null)
      .catch((e) => console.error("market news:", e));
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

  // With the agent economy on, the merchant's secret comes from its real purse and shelf.
  const priced = market ? await market.price(merchant, side, memory) : null;
  if (priced && "refusal" in priced) throw new HttpError(409, priced.refusal);

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
    priced ? { secret: priced.secret, escrow: priced.escrow } : undefined,
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
    /** Why the merchant prices the way it does today (no numbers that reveal the limit). */
    reasons: priced ? priced.reasons.map((r) => r.label) : [],
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
/** Canal Street city mode (apps/city): Slop New York + the game layer, served at /city/. */
const CITY_DIST = resolve(import.meta.dirname, "../../city/dist");
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
  const path = decodeURIComponent(url.split("?")[0]);
  if (path === "/city") {
    res.writeHead(301, { location: "/city/" });
    res.end();
    return true;
  }
  const [root, sub] = path.startsWith("/city/") ? [CITY_DIST, path.slice(5)] : [WEB_DIST, path];
  if (!existsSync(root)) return false;
  const rel = normalize(sub).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, rel);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
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
    if (req.method === "GET" && url === "/api/market") {
      if (!market) return send(res, 200, { agents: [], news: [], onchain: false });
      return send(res, 200, { agents: await market.agents(), news: await market.news(25), onchain: true, contractId: ledger!.contractId });
    }
    if (req.method === "POST" && url === "/api/invest") return send(res, 200, await invest(await readJson(req)));
    if (req.method === "GET" && url.startsWith("/api/orders"))
      return send(res, 200, await listOrders(new URL(url, "http://x").searchParams.get("player") ?? ""));
    const om = url.match(/^\/api\/orders\/([a-z0-9_-]{1,64})\/(take|deliver)$/);
    if (req.method === "POST" && om) return send(res, 200, await (om[2] === "take" ? takeOrder : deliverOrder)(om[1], await readJson(req)));
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
