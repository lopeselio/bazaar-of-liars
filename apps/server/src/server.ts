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
 *   GET  /api/stalls?player=…&visit=1   the stall slots, and the player's own stall (with what it
 *                                       earned since their last visit)
 *   POST /api/stalls/{licence|stock|withdraw|collect|list|unlist|buydeed|certify} {player,…}  run your
 *                                       own stall; list, unlist or buy a stall's deed (a NEP-171 NFT);
 *                                       certify your deed on Ethereum (an MPC Chain Signature)
 *   POST /api/dockwork {player,x,z}     a broke player works a shift at Pier 34 for the wholesaler
 *   GET  /api/auctions?player=…         the cargo ship lot at Pier 34 (sealed bids) and recent results
 *   POST /api/auctions/:id/bid {player,commitment,deposit,x,z}  seal a bid (hashed in the browser)
 *   POST /api/auctions/:id/reveal {player,amount,salt}           open it once bidding closes
 *   GET  /api/rumours?player=…          informants, their onchain records of truths and lies, and your tips
 *   POST /api/rumours/:informant/buy {player,x,z}  buy a tip (only its hash goes onchain)
 *   GET  /api/boards                    price boards across the city (live prices) and the best route
 *   POST /api/boards/:id/trade {player,goodId,x,z}  buy one at Wu's docks board, or sell one to a buyer uptown
 *   GET  /api/event?player=…           the current street event (festival, shortage, raid), and what a raid took from you
 *   GET  /api/auth/config               the NEAR Auth (Auth0) tenant the browser signs in with
 *   POST /api/auth/session {idToken}    verify a NEAR Auth login; returns the player's NEAR account + session
 *   POST /api/auth/link {guest}         (signed in) bring a guest's progress to the account
 *   /api/ba/*                           Better Auth (better-near-auth): sign in with a NEAR wallet (NEP-413), cookie session
 *
 * Players are guests ("guest-<hex>", anyone holding the id) or NEAR accounts (64-hex implicit
 * accounts from NEAR Auth). Anything done as a NEAR account needs that account's session token.
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
import { lastReport, runWatchdog } from "./watchdog.js";
import { BETTER_AUTH_PATH, betterAuthFromEnv, betterAuthHandler, migrateBetterAuth, sessionNearAccount } from "./betterAuth.js";
import { haggleHint, AGENTS, RAID_LIMIT, askMultiplier, bidMultiplier, eventActive, eventHeadline, raidSeizes, BOARDS, BOARD_REACH, askPrice, bestRoute, bidPrice, boardById, type PricedBoard, INFORMANTS, INFORMANT_REACH, TIP_HORIZON_MS, informantById, makeClaim, newSalt as freshSalt, plainClaim, tipCommitment, mulberry32, BID_WINDOW_MS, BROKE_BELOW, PIER_REACH, REVEAL_WINDOW_MS, SHIP_GAP_MS, CANAL_ORIGIN, DOCK, DOCK_REACH, DOCK_WAGE, GOODS, LICENCE_LEVEL, LICENCE_PRICE, MAX_STALL_PRICE, DEED_TAX_PCT, MAX_DEED_PRICE, sellerTake, suggestedAsk, MERCHANTS, STALL_SLOTS, XP, canTake, credView, fare as fareFor, impliedMode, routeMetres, type CredView, type Side, type TravelMode } from "@bazaar/core";
import { storeFromEnv, type DayRecord, type LiveRecord } from "./store.js";
import { AuthError, authFromEnv, derivedPublicKey, implicitAccount, isAccountPlayer, issueSession, sessionAccount, verifyIdToken } from "./auth.js";
import { Market } from "./market.js";
import { checkDeedCertificate, deedSignerAddress } from "@bazaar/verify";
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
  readCred,
  readInformants,
  readTips,
  readDeedCertificate,
  agentSignersFromEnv,
  readAgentAccounts,
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
const PLAYER_RE = /^(guest-[0-9a-f]{8,16}|[0-9a-f]{64})$/;
/** Any player id: a guest, or a NEAR account that signed in (implicit or named). */
const isPlayerId = (p: string) => PLAYER_RE.test(p) || isAccountPlayer(p);
const GUEST_RE = /^guest-[0-9a-f]{8,16}$/;

const llm = new NearAiClient(KEY);
const attestor = nearAiAttestor(KEY);

const store = await storeFromEnv();
console.log(`state store: ${store.kind}`);
// Canal Street's agent economy (contract v3): agents with their own accounts, purses and stock.
const onchainAccounts = ledger
  ? await readAgentAccounts(ledger.network, ledger.contractId).catch((e) => {
      console.warn(`couldn't read agent accounts from the contract (${(e as Error).message}); using AGENT_ACCOUNTS`);
      return {};
    })
  : {};
const signers = ledger ? agentSignersFromEnv(AGENTS.map((a) => a.id), process.env, onchainAccounts) : null;
// Agents barter through our testnet NEAR Intents Verifier (INTENTS_VERIFIER="" turns it off).
const INTENTS_VERIFIER = process.env.INTENTS_VERIFIER ?? "bazaar-intents.testnet";
const market = ledger && signers ? new Market(ledger, signers, store, INTENTS_VERIFIER || null) : null;
console.log(market ? `agent economy: on (v3)${Number(process.env.MARKET_TICK_MS ?? 0) > 0 ? ", agents acting" : ", agents idle here (set MARKET_TICK_MS to run them)"}` : "agent economy: off");
// Only one deployment should run the agents against a contract: the hosted demo sets
// MARKET_TICK_MS=40000. Locally the agents stay still unless you set it (reads still work).
const MARKET_TICK_MS = Number(process.env.MARKET_TICK_MS ?? 0);
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
// The harbour runs on a shorter beat than the street: bid and reveal windows are minutes long.
// On by default wherever the agents act; HARBOUR_TICK_MS overrides (0 turns it off).
const HARBOUR_TICK_MS = Number(process.env.HARBOUR_TICK_MS ?? (MARKET_TICK_MS > 0 ? 10_000 : 0));
if (market && HARBOUR_TICK_MS > 0)
  setInterval(async () => {
    const token = await store.lock("harbour-tick", 60_000).catch(() => null);
    if (!token) return;
    try {
      await market.harbour();
    } catch (e) {
      console.error("harbour:", (e as Error).message);
    } finally {
      await store.unlock("harbour-tick", token);
    }
  }, HARBOUR_TICK_MS).unref();

// Economy watchdog: on wherever the agents act; WATCHDOG_MS overrides (0 turns it off). It tops up
// agents' gas money from FUNDER_ACCOUNT_ID (key FUNDER_PRIVATE_KEY, or the local keychain).
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS ?? (MARKET_TICK_MS > 0 ? 600_000 : 0));
const watchdogDeps = market && ledger
  ? {
      store,
      network: ledger.network,
      serverId: process.env.SERVER_ACCOUNT_ID!,
      funder: process.env.FUNDER_ACCOUNT_ID ? { account: process.env.FUNDER_ACCOUNT_ID, privateKey: process.env.FUNDER_PRIVATE_KEY || undefined } : null,
      agents: () => market.agents(0),
      news: () => market.news(25),
    }
  : null;
if (watchdogDeps && WATCHDOG_MS > 0) {
  const watch = async () => {
    const token = await store.lock("watchdog", 5 * 60_000).catch(() => null);
    if (!token) return;
    try {
      await runWatchdog(watchdogDeps);
    } catch (e) {
      console.error("watchdog:", (e as Error).message);
    } finally {
      await store.unlock("watchdog", token);
    }
  };
  setTimeout(watch, 30_000).unref();
  setInterval(watch, WATCHDOG_MS).unref();
}

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

const utcDay = () => Math.floor(Date.now() / 86_400_000);
async function credOf(player: string): Promise<CredView | null> {
  if (!ledger) return null;
  return credView(await readCred(ledger.network, ledger.contractId, player).catch(() => ({ xp: 0, streak: 0, best_streak: 0, last_day: 0 })), utcDay());
}

async function playerView(player: string) {
  const [p, cred] = await Promise.all([purse(player), credOf(player)]);
  const w = worth(p);
  return { ...p, worth: w, cred, day: { ...(await dayOf(player, w)), perDay: HAGGLES_PER_DAY } };
}

async function invest(body: Record<string, unknown>) {
  if (!market || !ledger?.invest) throw new HttpError(404, "investing needs the agent economy");
  const player = playerOf(body);
  const agentId = String(body.agentId ?? "");
  const amount = Math.floor(Number(body.amount));
  if (!isPlayerId(player)) throw new HttpError(400, "unknown player id");
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
/** A contract refusal ("you've already worked a shift today") as a sentence for the player. */
const sentence = (m: string) => `${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? "" : "."}`;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

async function listOrders(player: string) {
  if (!market) return { orders: [], job: null, now: Date.now() };
  const now = Date.now();
  const cred = isPlayerId(player) ? await credOf(player) : null;
  const level = cred?.level ?? 1;
  // Each order says whether this player's level can take it yet.
  const orders = (await market.orders())
    .filter((o) => o.status === "open" && o.deadline_ms > now)
    .map((o) => {
      const c = canTake(level, o);
      return { ...o, needsLevel: c.ok ? null : c.needs };
    });
  const job = isPlayerId(player) ? await store.getJSON<Job>(`job:${player}`) : null;
  return { orders, job: job && orders.some((o) => o.id === job.orderId) ? job : null, now, level };
}

async function takeOrder(id: string, body: Record<string, unknown>) {
  if (!market) throw new HttpError(404, "deliveries need the agent economy");
  const player = playerOf(body);
  if (!isPlayerId(player)) throw new HttpError(400, "unknown player id");
  const x = num(body.x);
  const z = num(body.z);
  if (Number.isNaN(x) || Number.isNaN(z)) throw new HttpError(400, "where are you?");
  const o = (await market.orders(0)).find((x) => x.id === id);
  if (!o || o.status !== "open" || o.deadline_ms <= Date.now()) throw new HttpError(409, "That order is gone.");
  const gate = canTake((await credOf(player))?.level ?? 1, o);
  if (!gate.ok) throw new HttpError(403, `Reach street cred level ${gate.needs} to take ${o.express ? "express jobs" : `jobs at ${o.siteName}`}.`);
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
  const player = playerOf(body);
  if (!isPlayerId(player)) throw new HttpError(400, "unknown player id");
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

// ---------- dock work ----------

async function dockWork(body: Record<string, unknown>) {
  if (!market || !ledger?.payWages || !signers?.wu) throw new HttpError(404, "dock work needs the agent economy");
  const player = playerOf(body);
  if (!isPlayerId(player)) throw new HttpError(400, "unknown player id");
  if (Math.hypot(num(body.x) - DOCK.x, num(body.z) - DOCK.z) > DOCK_REACH) throw new HttpError(409, "Walk to the docks at the west end of Canal Street first.");
  const p = await purse(player);
  if (p.coins >= BROKE_BELOW) throw new HttpError(409, `Auntie Wu only takes on workers who are broke (under ${BROKE_BELOW} coins).`);
  // Auntie Wu signs for the wage herself; the contract checks the player is broke and hasn't worked today.
  const id = `w-${Date.now().toString(36)}-${player.slice(6, 12)}`;
  let tx: string;
  try {
    await signers.wu.authorizeSpend(id, DOCK_WAGE);
    tx = await ledger.payWages({ wageId: id, player });
  } catch (e) {
    const m = (e as Error).message.match(/Smart contract panicked: ([^"\n]+)/);
    throw new HttpError(409, m ? sentence(m[1]) : "Auntie Wu has no work right now. Try again.");
  }
  market.invalidate();
  await store.pushNews({ t: Date.now(), kind: "hire", text: `Auntie Wu hired a broke player to unload crates at Pier 34 for ${DOCK_WAGE}`, tx: explorerTx(ledger.network, tx), agents: ["wu"] });
  return { wage: DOCK_WAGE, txUrl: explorerTx(ledger.network, tx), player: await playerView(player) };
}

// ---------- cargo ship auctions at Pier 34 ----------

const refusal = (e: unknown, fallback: string) => {
  const m = (e as Error).message.match(/Smart contract panicked: ([^"\n]+)/);
  return new HttpError(409, m ? sentence(m[1]) : fallback);
};

async function auctionsView(player: string) {
  if (!market) return { lot: null, recent: [], windows: { bidMs: BID_WINDOW_MS, revealMs: REVEAL_WINDOW_MS, gapMs: SHIP_GAP_MS }, pier: DOCK };
  const all = await market.auctions();
  const name = (account: string) => AGENTS.find((a) => signers?.[a.id]?.account === account)?.name ?? (account === player ? "you" : `player ${shortPlayer(account)}`);
  const view = (a: (typeof all)[number]) => ({
    id: a.id,
    goodId: a.good_id,
    goodName: GOODS[a.good_id]?.name ?? a.good_id,
    qty: a.qty,
    reserve: a.reserve,
    opened: a.opened_ms,
    bidsClose: a.bids_close_ms,
    revealClose: a.reveal_close_ms,
    status: a.status,
    // Sealed bids show only who bid and the deposit; amounts appear as they're revealed.
    // Deposits stay hidden too while bidding is open: a deposit bounds the bid it covers.
    bids: a.bids.map((b) => {
      const mine = b.bidder === player;
      return { who: name(b.bidder), mine, agent: b.agent, deposit: mine || Date.now() >= a.bids_close_ms ? b.deposit : null, amount: b.amount };
    }),
    winner: a.winner ? name(a.winner) : null,
    youWon: a.winner === player,
    price: a.price,
  });
  const lot = all.find((a) => a.status === "bidding") ?? null;
  return {
    lot: lot ? view(lot) : null,
    recent: all.filter((a) => a.status !== "bidding").slice(0, 5).map(view),
    nextShip: (all[0]?.opened_ms ?? 0) + SHIP_GAP_MS,
    windows: { bidMs: BID_WINDOW_MS, revealMs: REVEAL_WINDOW_MS, gapMs: SHIP_GAP_MS },
    pier: DOCK,
  };
}

async function auctionAction(id: string, action: string, body: Record<string, unknown>) {
  if (!market || !ledger?.commitBid) throw new HttpError(404, "auctions need the agent economy");
  const player = playerOf(body);
  if (!isPlayerId(player)) throw new HttpError(400, "unknown player id");
  let tx: string;
  if (action === "bid") {
    if (Math.hypot(num(body.x) - DOCK.x, num(body.z) - DOCK.z) > PIER_REACH) throw new HttpError(409, "Walk to Pier 34 at the west end of Canal Street to bid.");
    const commitment = String(body.commitment ?? "");
    const deposit = Math.floor(Number(body.deposit));
    if (!/^[0-9a-f]{64}$/.test(commitment)) throw new HttpError(400, "a sealed bid is a sha256 hash");
    const p = await purse(player);
    if (!p.known) throw new HttpError(409, "Make your first deal on Canal Street before bidding at the docks.");
    if (!(deposit >= 1 && deposit <= p.coins)) throw new HttpError(402, `Your deposit can't be more than your ${p.coins} coins.`);
    try {
      tx = await ledger.commitBid({ auctionId: id, bidId: `b-${Date.now().toString(36)}`, bidder: player, commitment, deposit });
    } catch (e) {
      throw refusal(e, "The auctioneer didn't take that bid. Try again.");
    }
    // The bid is onchain now: nothing after this may fail the request, or the browser would drop its salt.
    await store.pushNews({ t: Date.now(), kind: "auction", text: "A player sealed a bid at Pier 34", tx: explorerTx(ledger.network, tx), agents: [] }).catch(() => {});
  } else {
    const amount = Math.floor(Number(body.amount));
    const salt = String(body.salt ?? "");
    if (!(amount >= 0) || !/^[0-9a-f]{32}$/.test(salt)) throw new HttpError(400, "a reveal needs the bid and its salt");
    try {
      tx = await ledger.revealBid!({ auctionId: id, bidder: player, amount, salt });
    } catch (e) {
      throw refusal(e, "The reveal didn't go through. Try again.");
    }
  }
  market.invalidate();
  const [auctions, me] = await Promise.all([auctionsView(player).catch(() => null), playerView(player).catch(() => null)]);
  return { ok: true, txUrl: explorerTx(ledger.network, tx), auctions, player: me };
}

// ---------- the rumour network ----------

const tipRng = mulberry32(Date.now() % 2 ** 31);

async function rumoursView(player: string, authed: string | null) {
  // A NEAR account's tips are only shown to that account's session.
  const owner = !isAccountPlayer(player) || authed === player;
  const records = ledger ? await readInformants(ledger.network, ledger.contractId, INFORMANTS.map((i) => i.id)).catch(() => []) : [];
  const informants = INFORMANTS.map((i) => {
    const r = records.find((x) => x.id === i.id) ?? { sold: 0, truths: 0, lies: 0, hidden: 0 };
    // Honesty stays secret: the record is all anyone gets.
    return { id: i.id, name: i.name, where: i.where, x: i.x, z: i.z, price: i.price, sold: r.sold, truths: r.truths, lies: r.lies, hidden: r.hidden };
  });
  let tips: unknown[] = [];
  if (ledger && isPlayerId(player)) {
    const mine = await readTips(ledger.network, ledger.contractId, player).catch(() => []);
    tips = await Promise.all(
      mine.map(async (t) => {
        const secret = market ? await market.tipSecret(t.id) : null;
        return {
          id: t.id,
          informant: informantById(t.informant)?.name ?? t.informant,
          price: t.price,
          checkMs: t.check_ms,
          status: t.status,
          // The buyer sees what they were told; everyone else only sees it once it resolves.
          text: owner && secret?.player === player ? secret.text : null,
          plain: t.claim ? describeClaim(t.claim) : owner && secret?.player === player ? describeClaim(secret.claim) : null,
          observed: t.observed,
          commitment: t.commitment,
        };
      }),
    );
  }
  return { informants, tips, reach: INFORMANT_REACH };
}

function describeClaim(c: { agent_id: string; good_id: string; at_most: boolean; n: number }) {
  const m = MERCHANTS.find((x) => x.id === c.agent_id);
  const good = GOODS[c.good_id];
  return plainClaim(c, { merchant: m?.name ?? c.agent_id, good: good ? good.name : c.good_id, sells: m?.goodId === c.good_id });
}

/** The informant puts the claim in their own words, with the private model; the facts are fixed. */
async function whisper(inf: (typeof INFORMANTS)[number], plain: string): Promise<string> {
  if (!KEY || !MODEL) return plain;
  try {
    const { content } = await llm.complete(
      {
        model: MODEL,
        messages: [
          { role: "system", content: `You are ${inf.name}, ${inf.voice}, an informant in New York's Chinatown. Whisper the tip you're given to the player in one or two short sentences, in character. Keep every fact exactly as given: the merchant, the good, the number, and "at most" vs "at least". Don't add facts. No stage directions.` },
          { role: "user", content: `The tip: ${plain}` },
        ],
        max_tokens: 120,
        temperature: 0.8,
        chat_template_kwargs: { enable_thinking: false },
      },
      8000,
    );
    const text = content.trim().replace(/^"|"$/g, "");
    return text.length > 10 && text.length < 500 ? text : plain;
  } catch {
    return plain;
  }
}

async function buyTip(informantId: string, body: Record<string, unknown>) {
  if (!market || !ledger?.sellTip) throw new HttpError(404, "rumours need the agent economy");
  const inf = informantById(informantId);
  if (!inf) throw new HttpError(404, "no such informant");
  const player = playerOf(body);
  if (!isPlayerId(player)) throw new HttpError(400, "unknown player id");
  if (Math.hypot(num(body.x) - inf.x, num(body.z) - inf.z) > INFORMANT_REACH) throw new HttpError(409, `Find ${inf.name} at ${inf.where} first.`);
  const p = await purse(player);
  if (!p.known) throw new HttpError(409, "Make your first deal on Canal Street before buying tips.");
  if (p.coins < inf.price) throw new HttpError(402, `${inf.name} wants ${inf.price} coins; you have ${p.coins}.`);
  const agents = await market.agents(0);
  const stock = MERCHANTS.map((m) => {
    const a = agents.find((x) => x.id === m.id);
    return { id: m.id, sells: m.goodId, sellsStock: a?.stock[m.goodId] ?? 0, buys: m.buysGoodId, buysStock: a?.stock[m.buysGoodId] ?? 0 };
  });
  const { claim } = makeClaim(tipRng, inf, stock);
  const id = `tip-${Date.now().toString(36)}-${randomInt(1e6).toString(36)}`;
  const salt = freshSalt();
  const checkMs = Date.now() + TIP_HORIZON_MS;
  const plain = describeClaim(claim);
  // The claim and salt are saved before the sale goes onchain, so the tip can always be revealed.
  await market.rememberTip({ id, informant: inf.id, player, claim, salt, checkMs, text: plain });
  let tx: string;
  try {
    tx = await ledger.sellTip({ tipId: id, informant: inf.id, player, commitment: tipCommitment(id, inf.id, claim, checkMs, salt), price: inf.price, checkMs });
  } catch (e) {
    await market.forgetTip(id).catch(() => {});
    const m = (e as Error).message.match(/Smart contract panicked: ([^"\n]+)/);
    throw new HttpError(409, m ? sentence(m[1]) : `${inf.name} clams up. Try again.`);
  }
  const text = await whisper(inf, plain);
  await market.setTipText(id, text).catch(() => {});
  market.invalidate();
  await store.pushNews({ t: Date.now(), kind: "rumour", text: `${inf.name} sold a player a tip`, tx: explorerTx(ledger.network, tx), agents: [] }).catch(() => {});
  return { tip: { id, informant: inf.name, text, plain, checkMs, price: inf.price }, txUrl: explorerTx(ledger.network, tx), player: await playerView(player).catch(() => null) };
}

// ---------- price boards and trade routes ----------

/** A price after an event's multiplier, within the contract's 1–500 range (null if that's impossible). */
const priced = (p: number | null, m: number) => {
  if (p === null) return null;
  const v = Math.round(p * m);
  return v > MAX_STALL_PRICE ? (p <= MAX_STALL_PRICE ? MAX_STALL_PRICE : null) : v;
};

/** Every board with its live prices: Wu's from her stock and cost, buyers' from distance and how much they've bought today. */
async function pricedBoards(): Promise<(PricedBoard & { stock: Record<string, number> })[]> {
  if (!market) return [];
  const [agents, event] = await Promise.all([market.agents(), market.event()]);
  return Promise.all(
    BOARDS.map(async (b) => {
      const a = agents.find((x) => x.id === b.agentId);
      const prices: Record<string, number | null> = {};
      for (const g of b.goods) {
        const base = GOODS[g]?.baseValue ?? 0;
        prices[g] =
          b.kind === "sells"
            ? // costBasis is rounded to whole coins; the half covers the rounding, so the contract's no-loss check passes.
              priced(askPrice(base, a?.stock[g] ?? 0, (a?.costBasis[g] ?? 0) + 0.5), askMultiplier(event, g))
            : priced(bidPrice(base, b, await store.count(`board:${b.id}:${g}`)), bidMultiplier(event, g));
      }
      return { ...b, prices, stock: Object.fromEntries(b.goods.map((g) => [g, a?.stock[g] ?? 0])) };
    }),
  );
}

async function boardsView() {
  const boards = await pricedBoards();
  return { boards, best: bestRoute(boards), reach: BOARD_REACH };
}

async function boardTrade(id: string, body: Record<string, unknown>) {
  if (!market || !ledger?.buyFromBoard || !signers) throw new HttpError(404, "boards need the agent economy");
  const board = boardById(id);
  if (!board) throw new HttpError(404, "no such board");
  const player = playerOf(body);
  const goodId = String(body.goodId ?? "");
  if (!isPlayerId(player)) throw new HttpError(400, "unknown player id");
  if (!board.goods.includes(goodId)) throw new HttpError(400, `${board.name} doesn't trade that.`);
  if (Math.hypot(num(body.x) - board.x, num(body.z) - board.z) > BOARD_REACH) throw new HttpError(409, `Walk to ${board.name} (${board.district}) to trade there.`);
  if (!(await purse(player)).known) throw new HttpError(409, "Make your first deal on Canal Street before trading across town.");
  // One board trade per player at a time, so parallel requests can't all pass the purse check.
  return withLock(`board:${player}`, () => settleBoardTrade(board, player, goodId, body), "Your last trade is still settling.");
}

async function settleBoardTrade(board: NonNullable<ReturnType<typeof boardById>>, player: string, goodId: string, body: Record<string, unknown>) {
  if (!market || !ledger?.buyFromBoard || !signers) throw new HttpError(404, "boards need the agent economy");
  const id = board.id;
  const p = await purse(player);
  const price = (await pricedBoards()).find((b) => b.id === id)?.prices[goodId] ?? null;
  if (price === null) throw new HttpError(409, board.kind === "sells" ? "Auntie Wu is keeping the rest of that for the merchants." : `${board.name} has had enough of that today.`);
  // The player trades at the price they were shown, or not at all.
  const expected = Math.floor(Number(body.expectedPrice));
  if (Number.isFinite(expected) && expected !== price) throw new HttpError(409, `The price just moved to ${price}. Check the board and try again.`);
  let tx: string;
  try {
    if (board.kind === "sells") {
      if (p.coins < price) throw new HttpError(402, `That's ${price}; you have ${p.coins}.`);
      tx = await ledger.buyFromBoard({ player, agentId: board.agentId, goodId, price });
    } else {
      if ((p.goods[goodId] ?? 0) < 1) throw new HttpError(409, `You don't have any ${GOODS[goodId].name} to sell.`);
      const buyer = (await market.agents(0)).find((a) => a.id === board.agentId);
      // A buyer short of coins draws on its (capped) daily income first: a round top-up, or just the shortfall.
      if (buyer && buyer.coins < price) {
        const short = price - buyer.coins;
        const pay = ledger.payIncome!;
        await pay({ agentId: board.agentId, amount: Math.max(short, 60) }).catch(() => pay({ agentId: board.agentId, amount: short }).catch(() => {}));
      }
      const saleId = `q-${Date.now().toString(36)}-${randomInt(1e6).toString(36)}`;
      await signers[board.agentId].authorizeSpend(saleId, price);
      try {
        tx = await ledger.sellToBoard!({ saleId, player, goodId });
      } catch (e) {
        // The buyer signed but the sale didn't happen: give its cap back.
        await ledger.releaseAuth!(saleId).catch((r) => console.error("release_auth:", (r as Error).message));
        throw e;
      }
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const m = (e as Error).message.match(/Smart contract panicked: ([^"\n]+)/);
    throw new HttpError(409, m ? sentence(m[1]) : "The trade didn't go through. Try again.");
  }
  if (board.kind === "buys") await store.bump(`board:${id}:${goodId}`, 24 * 3_600_000).catch(() => {});
  market.invalidate();
  const good = GOODS[goodId].name;
  await store
    .pushNews({ t: Date.now(), kind: "route", text: board.kind === "sells" ? `A player bought ${good} off Auntie Wu's board for ${price}` : `A player sold ${good} to ${board.name} (${board.district}) for ${price}`, tx: explorerTx(ledger.network, tx), agents: [board.agentId] })
    .catch(() => {});
  return { ok: true, price, txUrl: explorerTx(ledger.network, tx), boards: await boardsView().catch(() => null), player: await playerView(player).catch(() => null) };
}

// ---------- street events ----------

async function eventView(player: string) {
  const e = market ? await market.event() : null;
  const seized = e && isPlayerId(player) ? await store.getJSON<number>(`seized:${e.id}:${player}`) : null;
  return {
    event: e,
    active: eventActive(e),
    headline: e ? eventHeadline(e, (g) => GOODS[g]?.name ?? g) : null,
    raidLimit: RAID_LIMIT,
    // Whether this player has been inspected in the current raid, and what was taken.
    seized,
  };
}

/** During a raid, an unlicensed player who haggles on Canal Street is inspected (once per raid). */
async function raidCheck(player: string, goods: Record<string, number>) {
  if (!market || !ledger?.inspect) return null;
  const e = await market.event();
  if (!eventActive(e) || e.kind !== "raid") return null;
  if ((await store.getJSON<number>(`seized:${e.id}:${player}`)) !== null) return null;
  // Nothing over the limit: no call, and no mark either, so buying more later still gets inspected.
  if (raidSeizes(goods) === 0) return null;
  try {
    const tx = await ledger.inspect({ player, goodIds: GOOD_IDS });
    market.invalidate();
    const after = await purse(player);
    const taken = GOOD_IDS.reduce((n, g) => n + Math.max(0, (goods[g] ?? 0) - (after.goods[g] ?? 0)), 0);
    await store.putJSON(`seized:${e.id}:${player}`, taken, 3_600_000);
    if (taken) await store.pushNews({ t: Date.now(), kind: "event", text: `Inspectors seized ${taken} goods from an unlicensed trader on Canal Street`, tx: explorerTx(ledger.network, tx), agents: [] }).catch(() => {});
    return taken;
  } catch (e) {
    console.error("inspect:", (e as Error).message);
    return null;
  }
}

// ---------- player stalls ----------

const shortPlayer = (p: string) => p.slice(0, 12);

async function stallsView(player: string, visit: boolean) {
  const deedTerms = { deedTax: DEED_TAX_PCT, maxDeedPrice: MAX_DEED_PRICE };
  if (!market) return { slots: [], mine: null, licencePrice: LICENCE_PRICE, licenceLevel: LICENCE_LEVEL, ...deedTerms };
  const [stalls, asks] = await Promise.all([market.stalls(), market.deedAsks().catch(() => [])]);
  const askOf = (slot: string) => asks.find((a) => a.slot === slot)?.price ?? null;
  const slots = STALL_SLOTS.map((slot) => {
    const st = stalls.find((x) => x.slot === slot);
    return st
      ? { slot, owner: st.owner === player ? "you" : shortPlayer(st.owner), mine: st.owner === player, listings: st.listings.filter((l) => l.qty > 0), sold: st.sold, ask: askOf(slot), deedUrl: deedUrl(slot) }
      : { slot, owner: null, mine: false, listings: [], sold: 0, ask: null, deedUrl: null };
  });
  const own = isPlayerId(player) ? stalls.find((x) => x.owner === player) : undefined;
  let away: { sold: number; earned: number } | null = null;
  if (own && visit) {
    // What the stall did since the player last looked.
    const seen = await store.getJSON<{ sold: number; earned: number }>(`stallSeen:${player}`);
    if (seen && (own.sold > seen.sold || own.earned > seen.earned)) away = { sold: own.sold - seen.sold, earned: own.earned - seen.earned };
    await store.putJSON(`stallSeen:${player}`, { sold: own.sold, earned: own.earned }, 90 * 24 * 3_600_000);
  }
  const mine = own ? { ...own, ask: askOf(own.slot), suggestedAsk: suggestedAsk(own.earned), deedUrl: deedUrl(own.slot), certificate: await deedCertificate(own.slot, own.owner) } : null;
  return { slots, mine, away, licencePrice: LICENCE_PRICE, licenceLevel: LICENCE_LEVEL, ...deedTerms };
}

/** The bazaar's Ethereum address, derived from NEAR's MPC key for the contract (fixed, so read once). */
let deedSigner: Promise<{ signer: string; path: string; ethAddress: string }> | null = null;
function bazaarEth() {
  if (!ledger) return Promise.resolve(null);
  deedSigner ??= deedSignerAddress(ledger.network, ledger.contractId).catch((e) => {
    deedSigner = null;
    throw e;
  });
  return deedSigner.catch(() => null);
}

/** Certificates change only when someone certifies, so cache them (per replica) a little while. */
const certCache = new Map<string, { at: number; cert: Awaited<ReturnType<typeof readDeedCertificate>> }>();
async function cachedCertificate(slot: string) {
  const hit = certCache.get(slot);
  if (hit && Date.now() - hit.at < 30_000) return hit.cert;
  const cert = await readDeedCertificate(ledger!.network, ledger!.contractId, slot);
  certCache.set(slot, { at: Date.now(), cert });
  return cert;
}

/** A deed's Ethereum certificate, if it names the current owner, with our own check of it. */
async function deedCertificate(slot: string, owner: string) {
  if (!ledger) return null;
  const [cert, eth] = await Promise.all([cachedCertificate(slot).catch(() => certCache.get(slot)?.cert ?? null), bazaarEth()]);
  if (!cert || cert.owner !== owner || !eth) return null;
  const verified = checkDeedCertificate(cert, { contractId: ledger.contractId, ethAddress: eth.ethAddress }).every((c) => c.ok);
  return { ...cert, ethAddress: eth.ethAddress, signer: eth.signer, path: eth.path, verified };
}

/** The deed's page on the explorer (it's a NEP-171 token of the game contract). */
const deedUrl = (slot: string) => (ledger ? `https://${ledger.network === "testnet" ? "testnet." : ""}nearblocks.io/nft-token/${ledger.contractId}/${slot}` : null);

async function stallAction(action: string, body: Record<string, unknown>) {
  if (!market || !ledger?.buyLicence) throw new HttpError(404, "stalls need the agent economy");
  const player = playerOf(body);
  if (!isPlayerId(player)) throw new HttpError(400, "unknown player id");
  const goodId = String(body.goodId ?? "");
  const qty = Math.floor(Number(body.qty ?? 0));
  const price = Math.floor(Number(body.price ?? 0));
  const slot = String(body.slot ?? "");
  let tx: string;
  let news: string | null = null;
  try {
    if (action === "licence") {
      if (!(STALL_SLOTS as readonly string[]).includes(slot)) throw new HttpError(400, "no such stall slot");
      const cred = await credOf(player);
      if ((cred?.level ?? 1) < LICENCE_LEVEL) throw new HttpError(403, `A licence needs street cred level ${LICENCE_LEVEL}.`);
      const p = await purse(player);
      if (p.coins < LICENCE_PRICE) throw new HttpError(402, `A licence costs ${LICENCE_PRICE} coins; you have ${p.coins}.`);
      tx = await ledger.buyLicence({ player, slot });
      news = `A player opened a stall on Canal Street (${slot}). Its deed is an NFT now.`;
    } else if (action === "stock") {
      if (!GOODS[goodId]) throw new HttpError(400, "unknown good");
      if (!(qty >= 0 && qty <= 20 && price >= 1 && price <= MAX_STALL_PRICE)) throw new HttpError(400, `stock 0–20 at a price of 1–${MAX_STALL_PRICE}`);
      tx = await ledger.stockStall!({ player, goodId, qty, price });
    } else if (action === "withdraw") {
      if (!GOODS[goodId] || !(qty >= 1 && qty <= 20)) throw new HttpError(400, "withdraw 1–20 of a known good");
      tx = await ledger.withdrawStock!({ player, goodId, qty });
    } else if (action === "collect") {
      tx = await ledger.collectTill!(player);
    } else if (action === "list") {
      if (!ledger.listDeed) throw new HttpError(404, "the deed market isn't open");
      if (!(price >= 1 && price <= MAX_DEED_PRICE)) throw new HttpError(400, `ask 1–${MAX_DEED_PRICE} coins for a deed`);
      tx = await ledger.listDeed({ player, price });
      news = `A stall deed on Canal Street is for sale: ${price} coins`;
    } else if (action === "unlist") {
      if (!ledger.unlistDeed) throw new HttpError(404, "the deed market isn't open");
      tx = await ledger.unlistDeed(player);
    } else if (action === "certify") {
      if (!ledger.certifyDeed) throw new HttpError(404, "deed certificates aren't available");
      const own = (await market.stalls(0)).find((s) => s.owner === player);
      if (!own) throw new HttpError(409, "You don't have a stall.");
      // Each signature costs the server gas; one per player every few minutes is plenty.
      // The lock is atomic across replicas, and a failed attempt gives it back.
      const key = `certify:${player}`;
      const token = await store.lock(key, 5 * 60_000);
      if (!token) throw new HttpError(429, "Your deed was certified a moment ago. Try again in a few minutes.");
      // The transaction succeeds even when the MPC network doesn't answer (the contract logs it and
      // stores nothing), and the RPC can time out while the signature still lands. So the answer
      // is whether a newer certificate is there afterwards.
      const before = (await readDeedCertificate(ledger.network, ledger.contractId, own.slot).catch(() => null))?.block_height ?? 0;
      let sent: string | null = null;
      let failure: unknown = null;
      try {
        sent = await ledger.certifyDeed(own.slot);
      } catch (e) {
        failure = e;
      }
      certCache.delete(own.slot);
      const after = await readDeedCertificate(ledger.network, ledger.contractId, own.slot).catch(() => null);
      if (!after || after.block_height <= before || after.owner !== player) {
        await store.unlock(key, token).catch(() => {});
        if (failure) throw failure;
        throw new HttpError(502, "NEAR's MPC network didn't answer in time. Try again in a minute.");
      }
      tx = sent ?? "";
      news = `A stall deed on Canal Street (${own.slot}) was certified on Ethereum by NEAR's MPC network`;
    } else if (action === "buydeed") {
      if (!ledger.buyDeed) throw new HttpError(404, "the deed market isn't open");
      const [stalls, asks] = await Promise.all([market.stalls(0), market.deedAsks(0)]);
      const ask = asks.find((a) => a.slot === slot);
      if (!ask) throw new HttpError(409, "That deed isn't for sale any more.");
      if (ask.price !== price) throw new HttpError(409, `The asking price changed to ${ask.price}. Have another look.`);
      if (ask.owner === player) throw new HttpError(409, "That's your own deed.");
      if (stalls.some((s) => s.owner === player)) throw new HttpError(409, "You already have a stall. Sell or give it up first.");
      const p = await purse(player);
      if (p.coins < price) throw new HttpError(402, `The deed costs ${price} coins; you have ${p.coins}.`);
      tx = await ledger.buyDeed({ buyer: player, slot, price });
      news = `A stall deed on Canal Street (${slot}) changed hands for ${price} coins; the seller kept ${sellerTake(price)}`;
    } else throw new HttpError(404, "not found");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // Contract refusals ("you don't have a stall", "that slot is taken", …) are the player's to read.
    const m = (e as Error).message.match(/Smart contract panicked: ([^"\n]+)/);
    throw new HttpError(409, m ? sentence(m[1]) : "The street office refused that. Try again.");
  }
  market.invalidate();
  if (news) await store.pushNews({ t: Date.now(), kind: "stall", text: news, tx: explorerTx(ledger.network, tx), agents: [] }).catch(() => {});
  return { ok: true, txUrl: explorerTx(ledger.network, tx), stalls: await stallsView(player, false), player: await playerView(player) };
}

// ---------- signing in with NEAR Auth ----------

const auth = authFromEnv();

/** A NEAR-account player can only be acted for with that account's session. */
/** The request's player id: only ever a string (an array like ["alice"] would stringify past the guard). */
function playerOf(body: Record<string, unknown>): string {
  return typeof body.player === "string" ? body.player : "";
}

function guardPlayer(player: unknown, authed: string | null) {
  if (player !== undefined && player !== null && typeof player !== "string") throw new HttpError(400, "player must be a string");
  if (typeof player === "string" && isAccountPlayer(player) && authed !== player) throw new HttpError(401, "Sign in again to play as this account.");
}

async function startSession(body: Record<string, unknown>) {
  const idToken = String(body.idToken ?? "");
  let sub: string;
  try {
    sub = await verifyIdToken(idToken, auth);
  } catch (e) {
    if (e instanceof AuthError) throw new HttpError(401, `Sign-in failed: ${e.message}.`);
    throw e;
  }
  // The key NEAR Auth controls for this identity, and so the player's NEAR account.
  const publicKey = await derivedPublicKey(sub, auth);
  const account = implicitAccount(publicKey);
  const s = issueSession(account, auth);
  return { account, publicKey, token: s.token, exp: s.exp, player: await playerView(account) };
}

// ---------- sign in with a NEAR wallet: Better Auth + better-near-auth (SIWN, NEP-413) ----------

const ba = betterAuthFromEnv();
if (ba.usesDatabase) await migrateBetterAuth(ba.auth);
console.log(`wallet sign-in: better-near-auth, recipient ${ba.host}, ${ba.usesDatabase ? "Postgres" : "in-memory (local)"}`);
const baHandler = betterAuthHandler(ba.auth);
const walletAccountOf = sessionNearAccount(ba.auth);

async function linkGuest(body: Record<string, unknown>, authed: string | null) {
  if (!authed) throw new HttpError(401, "Sign in first.");
  if (!ledger?.mergePlayer) throw new HttpError(404, "linking needs the onchain ledger");
  const guest = String(body.guest ?? "");
  if (!GUEST_RE.test(guest)) throw new HttpError(400, "that isn't a guest id");
  try {
    await ledger.mergePlayer({ from: guest, to: authed, merchantIds: [...MERCHANTS.map((m) => m.id), "wu"], goodIds: GOOD_IDS });
  } catch (e) {
    const m = (e as Error).message.match(/Smart contract panicked: ([^"\n]+)/);
    throw new HttpError(409, m ? sentence(m[1]) : "Couldn't bring that progress over. Try again.");
  }
  // Server-side records follow the player too.
  const day = await store.getDay(guest);
  if (day) await store.putDay(authed, day, DAY_TTL_MS);
  market?.invalidate();
  return { ok: true, player: await playerView(authed) };
}

async function nextDay(body: Record<string, unknown>) {
  const player = playerOf(body);
  if (!isPlayerId(player)) throw new HttpError(400, "unknown player id");
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
  // Catching a merchant in a bluff is street cred only the server sees; the contract caps it per day.
  const caught = calls.filter((c) => c.result === "caught").length;
  if (caught && ledger?.awardCred)
    await ledger.awardCred({ player: l.player, xp: caught * XP.caughtBluff, reason: "caught_bluff" }).catch((e) => console.warn("award_cred:", (e as Error).message));
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
  const player = playerOf(body);
  const side: Side = body.side === "buy" ? "buy" : "sell";
  if (!merchant) throw new HttpError(400, "unknown merchant");
  if (!isPlayerId(player)) throw new HttpError(400, "unknown player id");
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
  // Inspectors on Canal Street: carrying too much without a licence costs you the excess.
  const seized = await raidCheck(player, me.goods);
  if (seized)
    throw new HttpError(409, `🚨 Inspectors stopped you on Canal Street and seized ${seized} goods (anything over ${RAID_LIMIT} of a kind, without a stall licence). Haggle again when you're ready.`);
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

async function turn(id: string, body: Record<string, unknown>, authed: string | null = null) {
  const text = String(body.text ?? "").trim().slice(0, MAX_TEXT);
  if (!text) throw new HttpError(400, "say something");
  if (!(await store.getLive(id))) throw new HttpError(404, "This haggle is over (or never existed).");

  return withLock(id, async () => {
    // Re-read under the lock: another replica may have just played a turn or closed it.
    const l = await store.getLive(id);
    if (!l) throw new HttpError(404, "This haggle is over (or never existed).");
    guardPlayer(l.player, authed);
    const session = restore(l);
    const t0 = Date.now();
    const askBefore = session.ask;
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
      hint:
        r.move.kind === "offer" && r.decision?.action === "counter"
          ? haggleHint({ side: session.side, askBefore, askAfter: session.ask, offer: r.move.price, tell: r.decision.tell, name: session.merchant.name.replace(/^Old /, "").split(" ")[0]! })
          : null,
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
  // Better Auth handles its own routes (and reads its own body).
  if (url.startsWith(`${BETTER_AUTH_PATH}/`)) return void baHandler(req, res);
  // Signed in: a NEAR Auth bearer token, or a Better Auth wallet session cookie.
  const authed = sessionAccount(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""), auth) ?? (await walletAccountOf(req.headers).catch(() => null));
  // Behind a hosting proxy the real client is the last X-Forwarded-For hop (the first is client-supplied).
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",").pop()?.trim() || req.socket.remoteAddress || "?";
  try {
    const body: Record<string, unknown> = req.method === "POST" && url.startsWith("/api/") ? await readJson(req) : {};
    guardPlayer(body.player, authed);
    if (req.method === "GET" && url === "/api/auth/config") return send(res, 200, { domain: auth.domain, clientId: auth.clientId, origins: auth.origins });
    if (req.method === "POST" && url === "/api/auth/session") return send(res, 200, await startSession(body));
    if (req.method === "POST" && url === "/api/auth/link") return send(res, 200, await linkGuest(body, authed));
    if (req.method === "GET" && url === "/api/merchants")
      return send(res, 200, {
        merchants: MERCHANTS.map((m) => ({ id: m.id, name: m.name, good: GOODS[m.goodId], buys: GOODS[m.buysGoodId] })),
        model: MODEL,
        onchain: ledger ? { network: ledger.network, contractId: ledger.contractId } : null,
      });
    if (req.method === "GET" && url.startsWith("/api/player")) {
      const id = new URL(url, "http://x").searchParams.get("id") ?? "";
      if (!isPlayerId(id)) throw new HttpError(400, "bad player id");
      return send(res, 200, await playerView(id));
    }
    if (req.method === "GET" && url === "/api/leaderboard")
      return send(res, 200, { leaders: ledger ? await readLeaderboard(ledger.network, ledger.contractId) : [] });
    if (req.method === "POST" && url === "/api/haggle") return send(res, 200, await openHaggle(body, ip));
    if (req.method === "POST" && url === "/api/day/next") return send(res, 200, await nextDay(body));
    if (req.method === "GET" && url === "/api/market") {
      if (!market) return send(res, 200, { agents: [], news: [], onchain: false });
      return send(res, 200, { agents: await market.agents(), news: await market.news(25), onchain: true, contractId: ledger!.contractId });
    }
    // Liveness for the deploy script and probes: the process answers and its state store responds.
    if (req.method === "GET" && url === "/api/health") {
      const t0 = Date.now();
      const storeOk = await store.getJSON("health:ping").then(() => true, () => false);
      return send(res, storeOk ? 200 : 503, { ok: storeOk, version: process.env.APP_VERSION ?? "dev", store: store.kind, storeMs: Date.now() - t0, onchain: !!ledger, agents: !!market });
    }
    if (req.method === "GET" && url === "/api/health/economy") {
      const r = await lastReport(store);
      return send(res, 200, r ?? { level: "unknown", checks: [], note: watchdogDeps ? "first check runs 30 s after start" : "the watchdog runs only where the agents act" });
    }
    if (req.method === "POST" && url === "/api/invest") return send(res, 200, await invest(body));
    if (req.method === "GET" && url.startsWith("/api/orders"))
      return send(res, 200, await listOrders(new URL(url, "http://x").searchParams.get("player") ?? ""));
    if (req.method === "GET" && url.startsWith("/api/stalls")) {
      const q = new URL(url, "http://x").searchParams;
      // Only the player themselves (or a guest) may mark the "while you were away" summary as seen.
      const who = q.get("player") ?? "";
      return send(res, 200, await stallsView(who, q.get("visit") === "1" && (!isAccountPlayer(who) || authed === who)));
    }
    if (req.method === "POST" && url === "/api/dockwork") return send(res, 200, await dockWork(body));
    if (req.method === "GET" && url.startsWith("/api/event")) return send(res, 200, await eventView(new URL(url, "http://x").searchParams.get("player") ?? ""));
    if (req.method === "GET" && url === "/api/boards") return send(res, 200, await boardsView());
    const bm = url.match(/^\/api\/boards\/([a-z0-9_-]{1,64})\/trade$/);
    if (req.method === "POST" && bm) return send(res, 200, await boardTrade(bm[1], body));
    if (req.method === "GET" && url.startsWith("/api/rumours")) return send(res, 200, await rumoursView(new URL(url, "http://x").searchParams.get("player") ?? "", authed));
    const rm = url.match(/^\/api\/rumours\/([a-z0-9_-]{1,64})\/buy$/);
    if (req.method === "POST" && rm) return send(res, 200, await buyTip(rm[1], body));
    if (req.method === "GET" && url.startsWith("/api/auctions")) return send(res, 200, await auctionsView(new URL(url, "http://x").searchParams.get("player") ?? ""));
    const am = url.match(/^\/api\/auctions\/([a-z0-9_-]{1,64})\/(bid|reveal)$/);
    if (req.method === "POST" && am) return send(res, 200, await auctionAction(am[1], am[2], body));
    const sm = url.match(/^\/api\/stalls\/(licence|stock|withdraw|collect|list|unlist|buydeed|certify)$/);
    if (req.method === "POST" && sm) return send(res, 200, await stallAction(sm[1], body));
    const om = url.match(/^\/api\/orders\/([a-z0-9_-]{1,64})\/(take|deliver)$/);
    if (req.method === "POST" && om) return send(res, 200, await (om[2] === "take" ? takeOrder : deliverOrder)(om[1], body));
    const m = url.match(/^\/api\/haggle\/([0-9a-f-]{36})\/turn$/);
    if (req.method === "POST" && m) return send(res, 200, await turn(m[1], body, authed));
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
