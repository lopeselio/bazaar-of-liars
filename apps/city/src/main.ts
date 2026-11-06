/**
 * Bazaar of Liars: Canal Street. The game layer on top of Slop New York.
 *
 * The city (vendor/slop-newyork) owns rendering, walking, driving and traffic. This module adds the
 * vendors' stalls on Canal Street, walk-up haggling against the same server API as apps/web, and the
 * game HUD. It talks to the city only through window.__slop (see the [bazaar] lines in js/main.js).
 */
import * as THREE from "three";
import "./style.css";
import { api, type Ending, type MarketAgent, type MerchantInfo, type NewsItem, type Opened, type PlayerView, type Side, type Tell, type TurnOut } from "../../web/src/api";
import { animateMerchant, buildStall, type StallLook } from "../../web/src/scene";
import { initJobs } from "./jobs";
import { initCred } from "./cred";

interface Bridge {
  scene: THREE.Scene;
  cameraSystem: { camera: THREE.PerspectiveCamera };
  controllerManager: {
    activeMode: string;
    getActiveEntity(): { position: THREE.Vector3; heading: number };
    teleportActiveTo(x: number, z: number, heading?: number): void;
    isPointOnSidewalk(x: number, z: number): boolean;
    getGroundHeight(x: number, z: number, mode?: string): number;
    resetInput(): void;
  };
  selectMode(mode: string): void;
  frame: Set<(dt: number, elapsed: number) => void>;
  ready: boolean;
}

const LOOKS: Record<string, StallLook> = {
  farrukh: { id: "farrukh", cloth: "#8c2f39", cloth2: "#e8c07a", robe: "#4a5d7a", skin: "#b07a55", hat: "wrap", good: "rug" },
  zaria: { id: "zaria", cloth: "#c4523b", cloth2: "#f0b448", robe: "#6a2c4a", skin: "#8a5a3c", hat: "hood", good: "saffron" },
  tobin: { id: "tobin", cloth: "#2e6e6a", cloth2: "#e9d9b0", robe: "#7a5a2e", skin: "#d9a982", hat: "cap", good: "lamp" },
};
const GOOD_ICON: Record<string, string> = { rug: "🧶", saffron: "🌶️", lamp: "🪔" };
/** Canal St through Chinatown, Baxter St → Mott St (Slop New York world coordinates, metres). */
const CANAL = { a: { x: 286, z: 4170 }, b: { x: 575, z: 4244 }, w: 18 };
const STALL_T = [0.28, 0.5, 0.72];
const REACH = 4.5;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const speech = (s: string) => esc(s).replace(/\*([^*]+)\*/g, '<em class="stage">$1</em>');
const shortName = (name: string) => name.replace(/^Old /, "").split(" ")[0];
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* fine */
    }
  },
};
function playerId() {
  let id = store.get("bazaar.player");
  if (!id || !/^guest-[0-9a-f]{8,16}$/.test(id)) {
    id = `guest-${[...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
    store.set("bazaar.player", id);
  }
  return id;
}
const PLAYER = playerId();

// ---------- DOM ----------

document.body.insertAdjacentHTML(
  "beforeend",
  `<div id="bz-hud" hidden>
     <div class="bz-card bz-title"><b>Bazaar of Liars</b><span>Canal Street</span></div>
     <div class="bz-card bz-purse"><span class="bz-coin">●</span><b id="bz-coins">–</b><span id="bz-goods"></span></div>
     <div class="bz-card bz-day" id="bz-day"></div>
     <button class="bz-card bz-go" id="bz-go" type="button">⇢ Canal St</button>
   </div>
   <section id="bz-wire" class="bz-card" hidden>
     <header><b>Canal St wire</b><span>agents trading onchain</span></header>
     <ol id="bz-news"></ol>
   </section>
   <div id="bz-tags"></div>
   <div id="bz-prompt" hidden><kbd>F</kbd><span id="bz-prompt-text"></span></div>
   <aside id="bz-panel" hidden>
     <header><div><h2 id="bz-name"></h2><p id="bz-sub"></p></div><button id="bz-close" type="button" aria-label="Leave">✕</button></header>
     <div id="bz-agent"></div>
     <div id="bz-choose"></div>
     <div class="bz-ask" id="bz-askrow" hidden><span id="bz-asklabel">Asking</span><b id="bz-ask">–</b><span id="bz-claim"></span></div>
     <div id="bz-steps"></div>
     <ul id="bz-reasons" hidden></ul>
     <ol id="bz-log"></ol>
     <div id="bz-quick"></div>
     <form id="bz-form" autocomplete="off"><input id="bz-input" maxlength="300" placeholder="Say something, or name a price…" disabled /><button id="bz-send" disabled>Say</button></form>
   </aside>
   <div id="bz-reveal" hidden></div>
   <div id="bz-burst"></div>`,
);

function toast(msg: string) {
  const t = document.createElement("div");
  t.className = "bz-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

// ---------- boot ----------

const bridge = await new Promise<Bridge>((resolve) => {
  const w = window as unknown as { __slop?: Bridge };
  const check = () => (w.__slop?.ready ? resolve(w.__slop) : false);
  if (!check()) addEventListener("slop:ready", () => check(), { once: false });
});

let merchants: MerchantInfo[] = [];
let me: PlayerView | null = null;
try {
  merchants = (await api.merchants()).merchants;
} catch {
  toast("Can't reach the bazaar server.");
}

// ---------- stalls ----------

interface CityStall {
  info: MerchantInfo;
  stall: ReturnType<typeof buildStall>;
  pos: THREE.Vector3;
  front: THREE.Vector3;
  tag: HTMLElement;
}
const cm = bridge.controllerManager;
const along = new THREE.Vector2(CANAL.b.x - CANAL.a.x, CANAL.b.z - CANAL.a.z).normalize();
const normal = new THREE.Vector2(-along.y, along.x);

function sidewalkSpot(t: number) {
  const cx = CANAL.a.x + (CANAL.b.x - CANAL.a.x) * t;
  const cz = CANAL.a.z + (CANAL.b.z - CANAL.a.z) * t;
  for (const side of [1, -1])
    for (let o = CANAL.w / 2 + 1.5; o < CANAL.w / 2 + 9; o += 0.5) {
      const x = cx + normal.x * o * side;
      const z = cz + normal.y * o * side;
      // Back from the kerb a little, so the counter isn't in the gutter.
      if (cm.isPointOnSidewalk(x, z) && cm.isPointOnSidewalk(x + normal.x * side * 1.5, z + normal.y * side * 1.5))
        return { x: x + normal.x * side * 1.5, z: z + normal.y * side * 1.5, toRoad: new THREE.Vector2(-normal.x * side, -normal.y * side) };
    }
  return { x: cx + normal.x * (CANAL.w / 2 + 4), z: cz + normal.y * (CANAL.w / 2 + 4), toRoad: new THREE.Vector2(-normal.x, -normal.y) };
}

const stalls: CityStall[] = merchants
  .filter((m) => LOOKS[m.id])
  .map((info, i) => {
    const spot = sidewalkSpot(STALL_T[i % STALL_T.length]);
    const stall = buildStall(LOOKS[info.id]);
    const y = cm.getGroundHeight(spot.x, spot.z, "person");
    stall.group.position.set(spot.x, y, spot.z);
    stall.group.rotation.y = Math.atan2(spot.toRoad.x, spot.toRoad.y); // the counter (+z) faces the street
    // A new light would make every material in the city recompile; the lanterns stay as glowing meshes.
    stall.lantern.removeFromParent();
    bridge.scene.add(stall.group);
    // The city turns off automatic matrix updates after it boots (scene.matrixWorldAutoUpdate = false).
    stall.group.updateMatrixWorld(true);
    const front = new THREE.Vector3(spot.x + spot.toRoad.x * 1.8, y, spot.z + spot.toRoad.y * 1.8);
    const tag = document.createElement("div");
    tag.className = "bz-tag";
    tag.innerHTML = `<b>${esc(shortName(info.name))}</b><span>${GOOD_ICON[info.good.id] ?? ""} sells ${esc(info.good.name)}</span><em class="bz-stock"></em>`;
    $("bz-tags").appendChild(tag);
    return { info, stall, pos: new THREE.Vector3(spot.x, y, spot.z), front, tag };
  });

function goToCanal() {
  const s = stalls[0];
  if (!s) return;
  bridge.selectMode("person");
  const back = new THREE.Vector3().subVectors(s.pos, s.front).normalize();
  // Stand on the pavement a few steps down the street, looking along it at the stalls.
  const x = s.front.x - along.x * 9 - back.x * 0.5;
  const z = s.front.z - along.y * 9 - back.z * 0.5;
  cm.teleportActiveTo(x, z, Math.atan2(along.x, along.y));
}
$("bz-go").addEventListener("click", goToCanal);
/** Stand at a stall's counter, facing the merchant. */
function goToStall(i: number) {
  const s = stalls[i];
  if (!s) return;
  bridge.selectMode("person");
  const toStall = new THREE.Vector3().subVectors(s.pos, s.front).setY(0).normalize();
  const x = s.front.x - toStall.x * 0.6;
  const z = s.front.z - toStall.z * 0.6;
  cm.teleportActiveTo(x, z, Math.atan2(toStall.x, toStall.z));
}
(window as unknown as { __bazaarCity: unknown }).__bazaarCity = { stalls, goToStall, goToCanal };
if (!store.get("bazaar.city.arrived")) {
  goToCanal();
  store.set("bazaar.city.arrived", "1");
}

// ---------- HUD ----------

const renderCred = initCred($("bz-hud"));

async function refreshPurse(bump = false) {
  try {
    me = await api.player(PLAYER);
  } catch {
    return;
  }
  $("bz-coins").textContent = String(me.coins);
  $("bz-goods").innerHTML = Object.entries(me.goods)
    .filter(([, n]) => n > 0)
    .map(([g, n]) => `<i>${GOOD_ICON[g] ?? "•"}${n}</i>`)
    .join("");
  $("bz-day").innerHTML = `Day <b>${me.day.n}</b> · ${me.day.left}/${me.day.perDay} haggles left`;
  renderCred(me.cred);
  if (bump) {
    const p = document.querySelector(".bz-purse")!;
    p.classList.remove("bump");
    void (p as HTMLElement).offsetWidth;
    p.classList.add("bump");
  }
}
$("bz-hud").hidden = false;
void refreshPurse();

// ---------- the agent economy: purses, shelves and the street wire ----------

let agents: Record<string, MarketAgent> = {};
let seenNews = 0;
const KIND_ICON: Record<string, string> = { sale: "🛍️", restock: "📦", hire: "🛵", trade: "🔁", consume: "🔧", invest: "💰", closed: "🚫" };
const ago = (t: number) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
function renderNews(news: NewsItem[]) {
  $("bz-news").innerHTML = news
    .slice(0, 6)
    .map((n) => `<li class="k-${n.kind}"><i>${KIND_ICON[n.kind] ?? "•"}</i><span>${esc(n.text)}</span>${n.tx ? `<a href="${n.tx}" target="_blank" rel="noopener" title="Settled onchain">tx</a>` : ""}<time>${ago(n.t)}</time></li>`)
    .join("");
  const newest = news[0]?.t ?? 0;
  if (seenNews && newest > seenNews) $("bz-wire").classList.add("ping");
  setTimeout(() => $("bz-wire").classList.remove("ping"), 900);
  seenNews = newest;
}
function renderStock() {
  for (const s of stalls) {
    const a = agents[s.info.id];
    const el = s.tag.querySelector(".bz-stock") as HTMLElement;
    if (!a) continue;
    const n = a.stock[s.info.good.id] ?? 0;
    el.className = `bz-stock ${a.status ?? ""}`;
    el.textContent = a.status === "broke" ? "SHUTTERED · broke" : n === 0 ? "SOLD OUT · restocking" : `${n} left · ${a.coins} coins`;
  }
}
async function refreshMarket() {
  try {
    const m = await api.market();
    if (!m.onchain) return;
    agents = Object.fromEntries(m.agents.map((a) => [a.id, a]));
    $("bz-wire").hidden = false;
    renderNews(m.news);
    renderStock();
    if (current && !current.side) renderAgentCard(current.s);
  } catch {
    /* the wire can wait */
  }
}
void refreshMarket();
setInterval(refreshMarket, 8000);

// ---------- delivery jobs across Manhattan ----------

initJobs({
  scene: bridge.scene,
  camera: () => bridge.cameraSystem.camera,
  player: PLAYER,
  cm,
  frame: bridge.frame,
  me: () => me,
  refreshPurse,
  toast,
  burst,
  goodIcon: GOOD_ICON,
  busy: () => !!current,
});

// ---------- per frame: tags, proximity, merchant body language ----------

const v = new THREE.Vector3();
let near: CityStall | null = null;
let current: { s: CityStall; side?: Side; opened?: Opened; busy: boolean; ended?: Ending } | null = null;

bridge.frame.add((dt, t) => {
  const cam = bridge.cameraSystem.camera;
  const ent = cm.getActiveEntity();
  const now = performance.now();
  let best: CityStall | null = null;
  let bestD = Infinity;
  for (const s of stalls) {
    animateMerchant(s.stall.merchant, t, dt, now);
    s.stall.merchant.root.updateMatrixWorld(true);
    v.copy(s.pos).setY(s.pos.y + 3.1).project(cam);
    const d = ent.position.distanceTo(s.pos);
    const visible = v.z < 1 && d < 80 && !current;
    s.tag.style.display = visible ? "" : "none";
    if (visible) {
      s.tag.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%) scale(${Math.max(0.6, Math.min(1, 18 / d))})`;
    }
    const reach = Math.hypot(ent.position.x - s.front.x, ent.position.z - s.front.z);
    if (cm.activeMode === "person" && reach < REACH && reach < bestD) {
      best = s;
      bestD = reach;
    }
  }
  if (best !== near) {
    near = best;
    $("bz-prompt").hidden = !near || !!current;
    if (near) $("bz-prompt-text").textContent = `Haggle with ${shortName(near.info.name)}`;
  }
});

addEventListener("keydown", (e) => {
  const typing = (e.target as HTMLElement)?.tagName === "INPUT";
  if (e.code === "KeyF" && !typing && near && !current) {
    e.preventDefault();
    openStall(near);
  }
  if (e.code === "Escape" && current && !current.busy) closeStall();
});

// ---------- haggle panel ----------

const log = $("bz-log");
function say(who: "you" | "them" | "sys", html: string, cls = "") {
  const li = document.createElement("li");
  li.className = `bz-${who} ${cls}`;
  li.innerHTML = html;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}
function setBusy(b: boolean) {
  if (!current) return;
  current.busy = b;
  ($("bz-input") as HTMLInputElement).disabled = b;
  ($("bz-send") as HTMLButtonElement).disabled = b;
  for (const btn of $("bz-quick").querySelectorAll("button")) (btn as HTMLButtonElement).disabled = b;
  if (!b) $("bz-input").focus();
}
function setAsk(n: number | null, claim: number | null = null) {
  $("bz-ask").textContent = n === null ? "–" : String(n);
  const side = current?.side;
  $("bz-claim").textContent = claim === null ? "" : side === "buy" ? `swears: not above ${claim}` : `swears: not below ${claim}`;
  renderQuick(n, claim);
}
function renderQuick(ask: number | null, claim: number | null) {
  const q = $("bz-quick");
  if (!current?.opened || ask === null) return void (q.innerHTML = "");
  const buying = current.side === "sell"; // the merchant sells, so the player buys
  const lo = Math.round(buying ? ask * 0.7 : ask * 1.3);
  const mid = Math.round(buying ? ask * 0.88 : ask * 1.12);
  q.innerHTML = `
    <button type="button" data-say="${buying ? `I'll give you ${lo}.` : `I want ${lo} for it.`}">${buying ? "Lowball" : "Push hard"} <b>${lo}</b></button>
    <button type="button" data-say="${buying ? `Meet me at ${mid}.` : `Make it ${mid}.`}">Meet me <b>${mid}</b></button>
    ${claim !== null ? `<button type="button" class="call" data-say="You're bluffing.">Call the bluff</button>` : ""}
    <button type="button" class="deal" data-say="Deal.">Take <b>${ask}</b></button>
    <button type="button" class="walk" data-say="I'm walking away.">Walk</button>`;
}
$("bz-quick").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (b?.dataset.say) void send(b.dataset.say);
});
$("bz-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const i = $("bz-input") as HTMLInputElement;
  const t = i.value.trim();
  if (t) void send(t);
  i.value = "";
});
$("bz-close").addEventListener("click", () => (current?.ended || !current?.opened ? closeStall() : void send("I'm walking away.")));

function openStall(s: CityStall) {
  current = { s, busy: false };
  $("bz-prompt").hidden = true;
  cm.resetInput();
  log.innerHTML = "";
  $("bz-steps").innerHTML = "";
  $("bz-quick").innerHTML = "";
  $("bz-askrow").hidden = true;
  $("bz-name").textContent = s.info.name;
  $("bz-sub").textContent = `${GOOD_ICON[s.info.good.id] ?? ""} sells ${s.info.good.name} · ${GOOD_ICON[s.info.buys.id] ?? ""} buys ${s.info.buys.name}`;
  $("bz-reasons").hidden = true;
  renderAgentCard(s);
  ($("bz-input") as HTMLInputElement).disabled = true;
  ($("bz-send") as HTMLButtonElement).disabled = true;
  $("bz-panel").hidden = false;
  document.body.classList.add("bz-talking");
  if (me && me.day.left <= 0) {
    $("bz-choose").innerHTML = `<p class="bz-note">The sun has set on Canal Street. Come back tomorrow.</p><button type="button" id="bz-next">Start the next day</button>`;
    $("bz-next").addEventListener("click", async () => {
      await api.nextDay(PLAYER).catch((e) => toast((e as Error).message));
      await refreshPurse();
      closeStall();
    });
    return;
  }
  const owned = me?.goods[s.info.buys.id] ?? 0;
  const coins = me?.coins ?? 0;
  $("bz-choose").innerHTML = `
    <button type="button" data-side="sell" ${coins > 0 ? "" : "disabled"}><b>Buy the ${esc(s.info.good.name)}</b><span>Worth about ${s.info.good.baseValue}. You have ${coins} coins.</span></button>
    <button type="button" data-side="buy" ${owned ? "" : "disabled"}><b>Sell your ${esc(s.info.buys.name)}</b><span>${owned ? `You have ${owned}. Worth about ${s.info.buys.baseValue}.` : "You don't have one. Buy one at another stall."}</span></button>`;
  $("bz-choose")
    .querySelectorAll("button[data-side]")
    .forEach((b) => b.addEventListener("click", () => void start((b as HTMLElement).dataset.side as Side)));
}

/** The merchant is an agent with its own NEAR account: show its wallet, shelf and policy. */
function renderAgentCard(s: CityStall) {
  const a = agents[s.info.id];
  const card = $("bz-agent");
  if (!a) return void (card.innerHTML = "");
  const n = a.stock[s.info.good.id] ?? 0;
  const cost = a.costBasis[s.info.good.id];
  const canInvest = a.status !== "open" && !current?.side;
  card.innerHTML = `
    <div class="bz-wallet">
      <span class="bz-chip">AI agent</span>
      <a href="${a.accountUrl}" target="_blank" rel="noopener" title="This merchant's own NEAR account">${esc(a.account)} ↗</a>
    </div>
    <div class="bz-agent-facts">
      <div><span>Purse</span><b>${a.coins}</b></div>
      <div><span>${esc(s.info.good.name)}</span><b>${n}</b></div>
      <div><span>Paid each</span><b>${cost || "–"}</b></div>
      <div><span>Spent today</span><b>${a.spentToday}/${a.dailyCap}</b></div>
    </div>
    ${
      canInvest
        ? `<div class="bz-invest"><p>${a.status === "broke" ? `${esc(shortName(s.info.name))} is broke and can't restock.` : `${esc(shortName(s.info.name))} is sold out. A lot is on its way from the docks.`} Invest to help it restock:</p>
           <button type="button" data-invest="20">Invest 20</button><button type="button" data-invest="50">Invest 50</button></div>`
        : ""
    }`;
  card.querySelectorAll<HTMLButtonElement>("button[data-invest]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const r = await api.invest(PLAYER, s.info.id, Number(b.dataset.invest));
        toast(`Invested ${b.dataset.invest} coins in ${shortName(s.info.name)}.`);
        void r;
        await Promise.all([refreshPurse(true), refreshMarket()]);
      } catch (e) {
        toast((e as Error).message);
        b.disabled = false;
      }
    }),
  );
}

function closeStall() {
  if (current) current.s.stall.merchant.tell = "relaxed";
  current = null;
  $("bz-panel").hidden = true;
  $("bz-reveal").hidden = true;
  document.body.classList.remove("bz-talking");
  near = null; // re-evaluated next frame
}

async function start(side: Side) {
  if (!current || current.side) return;
  const s = current.s;
  current.side = side;
  current.busy = true;
  $("bz-choose").innerHTML = "";
  $("bz-steps").innerHTML = `<p class="doing">Verifying ${esc(shortName(s.info.name))}'s AI enclave <small>Intel TDX + NVIDIA</small></p>`;
  const t = setTimeout(() => ($("bz-steps").innerHTML += `<p class="doing">Sealing the secret price on NEAR</p>`), 4000);
  try {
    const opened = await api.open(s.info.id, PLAYER, side);
    clearTimeout(t);
    if (!current || current.s !== s) return;
    current.opened = opened;
    $("bz-steps").innerHTML = `<p class="done">🔒 Secret sealed on NEAR${opened.openTxUrl ? ` · <a href="${opened.openTxUrl}" target="_blank" rel="noopener">tx</a>` : ""}</p>`;
    $("bz-asklabel").textContent = side === "sell" ? "Asking" : "Offering you";
    if (opened.reasons?.length) {
      $("bz-reasons").innerHTML = `<li class="h">Why ${esc(shortName(s.info.name))} prices it this way today</li>` + opened.reasons.map((r) => `<li>${esc(r)}</li>`).join("");
      $("bz-reasons").hidden = false;
    }
    $("bz-askrow").hidden = false;
    if (opened.memory.lowballs || opened.memory.deals)
      say("sys", opened.memory.grudge > 0 ? `${esc(shortName(s.info.name))} remembers your lowballs. Prices start higher.` : `${esc(shortName(s.info.name))} remembers you. A friend's price.`);
    say("them", side === "sell" ? `For you? <b>${opened.openingAsk}</b>. A fair price.` : `I'll give you <b>${opened.openingAsk}</b> for it.`);
    setAsk(opened.openingAsk);
    s.stall.merchant.talkUntil = performance.now() + 1400;
    setBusy(false);
  } catch (e) {
    clearTimeout(t);
    $("bz-steps").innerHTML = "";
    say("sys", esc((e as Error).message), "bad");
    current.side = undefined;
    current.busy = false;
  }
}

async function send(text: string) {
  if (!current?.opened || current.busy || current.ended) return;
  const s = current.s;
  say("you", esc(text));
  setBusy(true);
  const typing = document.createElement("li");
  typing.className = "bz-them bz-typing";
  typing.innerHTML = "<i></i><i></i><i></i>";
  log.appendChild(typing);
  let r: TurnOut;
  try {
    r = await api.turn(current.opened.haggleId, text);
  } catch (e) {
    typing.remove();
    say("sys", esc((e as Error).message), "bad");
    setBusy(false);
    return;
  }
  typing.remove();
  if (!current || current.s !== s) return;
  if (r.refused) {
    say("sys", `You only have ${r.refused.budget} coins.`, "bad");
    setBusy(false);
    return;
  }
  if (r.text) {
    say("them", speech(r.text));
    s.stall.merchant.talkUntil = performance.now() + Math.min(4000, 600 + r.text.length * 35);
  }
  if (r.tell) s.stall.merchant.tell = r.tell as Tell;
  if (r.call === "caught") say("sys", "🎯 <b>Caught!</b> The price collapses.", "good");
  if (r.call === "honest") say("sys", "😤 They were telling the truth. That stung.", "bad");
  if (r.action === "final") say("sys", "That's their final price.");
  setAsk(r.ask, r.claim);
  if (r.end) return finish(r.end);
  setBusy(false);
}

function burst(n: number) {
  const b = $("bz-burst");
  for (let i = 0; i < Math.min(24, 6 + Math.abs(n) / 4); i++) {
    const c = document.createElement("i");
    c.style.setProperty("--dx", `${(Math.random() - 0.5) * 320}px`);
    c.style.setProperty("--dy", `${-120 - Math.random() * 220}px`);
    c.style.animationDelay = `${Math.random() * 0.15}s`;
    b.appendChild(c);
    setTimeout(() => c.remove(), 1400);
  }
}

function finish(end: Ending) {
  if (!current) return;
  current.ended = end;
  current.busy = true;
  $("bz-quick").innerHTML = "";
  const s = current.s;
  const deal = end.status === "deal";
  if (deal) burst(end.dealPrice ?? 10);
  const passed = end.checks.filter((c) => c.ok).length;
  const buying = end.side === "sell";
  const lies = end.claims.filter((c) => !c.truth).length;
  const caught = end.calls.filter((c) => c.result === "caught").length;
  $("bz-reveal").innerHTML = `
    <div class="bz-rv">
      <p class="eyebrow">${deal ? "Deal" : end.status === "walked" ? "They walked" : "You walked"} · the secret, revealed</p>
      <h3>${esc(shortName(s.info.name))}'s real ${buying ? "floor" : "limit"} was <b>${end.secret.floor}</b></h3>
      <div class="bz-facts">
        <div><span>${deal ? (buying ? "You paid" : "You got") : "Last price"}</span><b>${end.dealPrice ?? "–"}</b></div>
        <div><span>Left on the table</span><b>${end.leftOnTable ?? "–"}</b></div>
        <div><span>Bluffs</span><b>${lies}/${end.claims.length}</b></div>
        <div><span>Caught</span><b>${caught}</b></div>
      </div>
      <p class="bz-verdict ${passed === end.checks.length ? "ok" : "bad"}">${passed === end.checks.length ? "✓" : "✗"} Fair play: ${passed}/${end.checks.length} checks${end.chain?.closeTxUrl ? ` · <a href="${end.chain.closeTxUrl}" target="_blank" rel="noopener">reveal tx</a>` : ""}</p>
      <button type="button" id="bz-done">Back to the street</button>
    </div>`;
  $("bz-reveal").hidden = false;
  $("bz-done").addEventListener("click", closeStall);
  void refreshPurse(true);
  setTimeout(() => void refreshMarket(), 2500);
}
