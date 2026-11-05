/**
 * Haggle orchestrator for the web game.
 *
 *   GET  /api/merchants                 the stalls
 *   GET  /api/player?id=guest-…         coins + goods, read from the bazaar contract
 *   GET  /api/leaderboard               richest traders (peak purse), from the contract
 *   POST /api/haggle {merchantId,player,side} attest the model, roll + commit the secret onchain
 *   POST /api/haggle/:id/turn {text}    one turn; when the haggle ends the response carries the reveal
 *
 * Privacy: haggle state lives in memory only. When a haggle ends it's revealed onchain, the proof
 * bundle is handed to the player, and the session is deleted. Nothing is written to disk.
 * In production this also serves apps/web/dist.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { randomInt } from "node:crypto";
import { GOODS, MERCHANTS, type Side } from "@bazaar/core";
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
const GOOD_IDS = Object.keys(GOODS);
const PLAYER_RE = /^guest-[0-9a-f]{8,16}$/;

const llm = new NearAiClient(KEY);
const attestor = nearAiAttestor(KEY);

interface Live {
  session: HaggleSession;
  player: string;
  budget: number;
  lastActive: number;
  busy: boolean;
  turns: number;
}
const live = new Map<string, Live>();
const activeByPlayer = new Map<string, string>();
const opensByIp = new Map<string, number[]>();

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

function rateLimit(ip: string) {
  const now = Date.now();
  const recent = (opensByIp.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= HAGGLES_PER_IP_PER_HOUR) throw new HttpError(429, "Too many haggles this hour. The merchants need a rest.");
  recent.push(now);
  opensByIp.set(ip, recent);
}

async function playerView(player: string) {
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

/** Close onchain, build + verify the bundle, forget the session. */
async function finish(id: string, l: Live) {
  live.delete(id);
  if (activeByPlayer.get(l.player) === id) activeByPlayer.delete(l.player);
  const chain = await l.session.close();
  const bundle = await l.session.bundle();
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
    bundle,
  };
}

// Idle haggles are revealed (no deal) and dropped.
setInterval(() => {
  const now = Date.now();
  for (const [id, l] of live) if (!l.busy && now - l.lastActive > IDLE_MS) void finish(id, l).catch((e) => console.error("idle close failed", e));
}, 60_000).unref();

// ---------- routes ----------

async function openHaggle(body: Record<string, unknown>, ip: string) {
  const merchant = MERCHANTS.find((m) => m.id === body.merchantId);
  const player = String(body.player ?? "");
  const side: Side = body.side === "buy" ? "buy" : "sell";
  if (!merchant) throw new HttpError(400, "unknown merchant");
  if (!PLAYER_RE.test(player)) throw new HttpError(400, "player must look like guest-<hex>");
  rateLimit(ip);

  // One haggle per player at a time, so two tabs can't overspend the same coins.
  const prev = activeByPlayer.get(player);
  if (prev && live.has(prev)) await finish(prev, live.get(prev)!);

  const me = await playerView(player);
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
  live.set(session.id, { session, player, budget: me.coins, lastActive: Date.now(), busy: false, turns: 0 });
  activeByPlayer.set(player, session.id);

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
  const l = live.get(id);
  if (!l) throw new HttpError(404, "This haggle is over (or never existed).");
  if (l.busy) throw new HttpError(409, "The merchant is still talking.");
  const text = String(body.text ?? "").trim().slice(0, MAX_TEXT);
  if (!text) throw new HttpError(400, "say something");

  l.busy = true;
  l.lastActive = Date.now();
  try {
    const t0 = Date.now();
    // Out of turns: walk the player out.
    const r = await l.session.turn(++l.turns > MAX_TURNS ? "leave" : text, l.budget);
    const out: Record<string, unknown> = {
      text: r.text,
      action: r.decision?.action ?? (r.move.kind === "leave" ? "left" : null),
      price: r.decision?.price ?? null,
      tell: r.decision?.tell ?? null,
      status: r.status,
      ask: l.session.status === "open" || l.session.status === "deal" ? l.session.ask : null,
      refused: r.refused ?? null,
      claim: l.session.claim ?? null,
      call: r.decision?.call ?? null,
      ms: Date.now() - t0,
    };
    if (r.refused) l.turns--;
    if (l.session.status !== "open") out.end = await finish(id, l);
    return out;
  } finally {
    l.busy = false;
  }
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
