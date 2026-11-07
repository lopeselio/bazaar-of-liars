/**
 * Cargo ship auctions at Pier 34.
 *
 * Every few minutes a ship docks at the west end of Canal Street (a horn sounds and a banner
 * points the way). The contract rolls the lot itself. Bids are sealed: this browser picks a
 * random salt, hashes the bid with it and sends only the hash and a deposit. The salt never
 * leaves this browser until bidding closes, when it reveals the bid automatically. Auntie Wu,
 * the merchants and the rival traders bid too, from their own purses.
 */
import * as THREE from "three";
import { api, type AuctionLot, type AuctionsView, type PlayerView } from "../../web/src/api";

/** Mirrors packages/core auctions.ts and wages.ts. */
const PIER = { x: -744, z: 3926 };
const REACH = 60;

export interface AuctionDeps {
  scene: THREE.Scene;
  camera: () => THREE.Camera;
  player: string;
  cm: { getActiveEntity(): { position: THREE.Vector3 }; getGroundHeight(x: number, z: number, mode?: string): number };
  frame: Set<(dt: number, t: number) => void>;
  me: () => PlayerView | null;
  refreshPurse: (bump?: boolean) => Promise<unknown>;
  toast: (msg: string) => void;
  burst: (n: number) => void;
  goodIcon: Record<string, string>;
  busy: () => boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A deposit that covers the bid without giving it away (core depositFor). */
const depositFor = (amount: number, reserve: number, coins: number) => Math.max(reserve, amount, Math.min(coins, Math.ceil((amount + 1) / 50) * 50));

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const randomSalt = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** This browser's sealed bids: the amount and salt, kept here until the reveal. */
type Sealed = { amount: number; salt: string; revealed?: boolean };
const sealedKey = (id: string) => `bazaar.bid.${id}`;
function loadSealed(id: string): Sealed | null {
  try {
    return JSON.parse(localStorage.getItem(sealedKey(id)) ?? "null");
  } catch {
    return null;
  }
}
function saveSealed(id: string, s: Sealed) {
  try {
    localStorage.setItem(sealedKey(id), JSON.stringify(s));
  } catch {
    /* private mode: the bid still stands, but must be revealed from this tab */
  }
}

/** A short ship's horn, made on the spot (no audio files). */
function horn() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sawtooth";
    o.frequency.value = 98;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.15);
    g.gain.setValueAtTime(0.12, ctx.currentTime + 1.3);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.8);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 1.9);
  } catch {
    /* no audio until the player has interacted */
  }
}

/** A small freighter: hull, bridge, funnel and a deck of crates. */
function buildShip() {
  const g = new THREE.Group();
  const mat = (c: string) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(14, 6, 60), mat("#7a2620"));
  hull.position.y = 1;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(14.2, 0.6, 60.2), mat("#3b2a22"));
  deck.position.y = 4.2;
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(10, 7, 8), mat("#e8e1d3"));
  bridge.position.set(0, 8, -22);
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 6, 12), mat("#d9a21b"));
  funnel.position.set(0, 14, -24);
  g.add(hull, deck, bridge, funnel);
  const colors = ["#3e6fb0", "#c8553d", "#5c8a4a", "#d9a21b"];
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(5.6, 3, 7), mat(colors[i % colors.length]));
    c.position.set(i % 2 ? 3 : -3, 6, -10 + Math.floor(i / 2) * 8);
    g.add(c);
  }
  return g;
}

export function initAuctions(d: AuctionDeps) {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="bz-ship" hidden><i id="bz-ship-arrow">➤</i><div><b id="bz-ship-title"></b><span id="bz-ship-sub"></span></div></div>
     <div id="bz-pier-prompt" hidden><kbd>G</kbd><span id="bz-pier-text">Bid on the cargo</span></div>
     <aside id="bz-auction" class="bz-card" hidden></aside>`,
  );

  // The ship lies in the Hudson off the pier, the beam marks where to stand.
  const y = d.cm.getGroundHeight(PIER.x, PIER.z, "person");
  const ship = buildShip();
  ship.position.set(PIER.x - 46, y - 3, PIER.z);
  ship.visible = false;
  d.scene.add(ship);
  ship.updateMatrixWorld(true);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(2.6, 2.6, 140, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: "#ffc45c", transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  );
  beam.position.set(PIER.x, y + 70, PIER.z);
  beam.visible = false;
  d.scene.add(beam);
  beam.updateMatrixWorld(true);

  let view: AuctionsView | null = null;
  let open = false;
  let atPier = false;
  let sending = false;
  let lastLot = "";
  const announced = new Set<string>();
  const lot = () => view?.lot ?? null;
  const phase = (l: AuctionLot, now = Date.now()) => (now < l.bidsClose ? "bidding" : now < l.revealClose ? "reveal" : "settling");

  async function refresh() {
    try {
      view = await api.auctions(d.player);
    } catch {
      return;
    }
    const l = lot();
    if (l && l.id !== lastLot) {
      if (lastLot) {
        horn();
        d.toast(`A cargo ship docked at Pier 34 with ${l.qty} ${l.goodName}. Sealed bids close in ${clock(l.bidsClose - Date.now())}.`);
      }
      lastLot = l.id;
    }
    if (!lastLot) lastLot = l?.id ?? "none";
    await autoReveal();
    announceResults();
    // Don't rebuild the panel under a player who's typing a bid.
    if (open && document.activeElement?.id !== "bz-auc-amt") render();
  }

  /** Once bidding closes, open this browser's sealed bid. */
  async function autoReveal() {
    const l = lot();
    if (!l || phase(l) !== "reveal") return;
    const s = loadSealed(l.id);
    const mine = l.bids.find((b) => b.mine);
    if (!s || s.revealed || !mine || mine.amount !== null) return;
    try {
      const r = await api.reveal(l.id, d.player, s.amount, s.salt);
      saveSealed(l.id, { ...s, revealed: true });
      view = r.auctions ?? view;
      d.toast(`Your sealed bid of ${s.amount} is open. The lot settles in ${clock(l.revealClose - Date.now())}.`);
    } catch (e) {
      d.toast((e as Error).message);
      if (/already revealed|does not match/.test((e as Error).message)) saveSealed(l.id, { ...s, revealed: true });
    }
  }

  /** Tell the player how a lot they bid on ended. */
  function announceResults() {
    for (const a of view?.recent ?? []) {
      if (announced.has(a.id)) continue;
      announced.add(a.id);
      const mine = a.bids.find((b) => b.mine);
      if (!mine || !loadSealed(a.id) || Date.now() - a.revealClose > 10 * 60_000) continue;
      if (a.youWon) {
        d.toast(`You won ${a.qty} ${a.goodName} for ${a.price}! Your deposit's change is back in your purse.`);
        d.burst(a.qty * 3);
      } else d.toast(a.winner ? `${a.winner} won the ${a.goodName} lot for ${a.price}. Your deposit is back.` : `Nobody met the reserve on the ${a.goodName}. Your deposit is back.`);
      void d.refreshPurse(true);
    }
  }

  function render() {
    const el = $("bz-auction");
    const l = lot();
    const coins = d.me()?.coins ?? 0;
    if (!l) {
      const next = view?.nextShip ? view.nextShip - Date.now() : 0;
      el.innerHTML = `<header><div><h2>⚓ Pier 34 auctions</h2><p>${next > 0 ? `Next ship due in about ${clock(next)}.` : "A ship is due any moment."}</p></div><button type="button" id="bz-auc-x" aria-label="Close">✕</button></header>
        ${recentHtml()}`;
    } else {
      const ph = phase(l);
      const s = loadSealed(l.id);
      const mine = l.bids.find((b) => b.mine);
      const bids = l.bids.length
        ? `<ul class="bz-listings">${l.bids
            .map((b) => `<li><span>${b.mine ? "🫵 " : b.agent ? "🤖 " : "🧑 "}${esc(b.who)}</span><span class="bz-dim">${b.deposit === null ? "deposit hidden" : `deposit ${b.deposit}`}</span><b>${b.amount === null ? "🔒 sealed" : b.amount}</b></li>`)
            .join("")}</ul>`
        : `<p class="bz-note">No bids yet.</p>`;
      const suggested = Math.max(l.reserve, Math.round(l.reserve * 1.25));
      const form =
        ph !== "bidding"
          ? `<p class="bz-note">${ph === "reveal" ? (mine ? (s ? "Revealing your bid from this browser…" : "Your bid was sealed in another browser: reveal it there.") : "Bids are being opened.") : "The auctioneer is settling the lot."}</p>`
          : mine
            ? `<p class="bz-note">Your bid is sealed${s ? ` (${s.amount}, known only to this browser)` : ""}. It opens itself when bidding closes, as long as this page is open.</p>`
            : !atPier
              ? `<p class="bz-note">Walk to the beam on Pier 34 to bid.</p>`
              : `<label class="bz-price">Your bid <input id="bz-auc-amt" type="number" min="${l.reserve}" max="${coins}" value="${Math.min(coins, suggested)}"> coins</label>
                 <p class="bz-note" id="bz-auc-dep"></p>
                 <button type="button" id="bz-auc-bid">🔒 Seal my bid</button>`;
      el.innerHTML = `<header><div><h2>${d.goodIcon[l.goodId] ?? "📦"} ${l.qty} × ${esc(l.goodName)}</h2><p>Reserve ${l.reserve} · ${ph === "bidding" ? `bids close in <b id="bz-auc-clock">${clock(l.bidsClose - Date.now())}</b>` : ph === "reveal" ? `opening bids · <b id="bz-auc-clock">${clock(l.revealClose - Date.now())}</b>` : "settling…"}</p></div><button type="button" id="bz-auc-x" aria-label="Close">✕</button></header>
        <p class="bz-note">Sealed-bid auction: everyone bids once, blind. Highest bid at or above the reserve wins and pays what it bid. Only a hash goes onchain until bidding closes.</p>
        <h4>Bids</h4>${bids}${form}${recentHtml()}`;
      const amt = $("bz-auc-amt") as HTMLInputElement | null;
      const showDep = () => {
        if (!amt) return;
        const a = Math.floor(Number(amt.value));
        $("bz-auc-dep").textContent = a >= l.reserve ? `Locks a deposit of ${depositFor(a, l.reserve, coins)}: a round figure, so it doesn't give your bid away. A bid you don't reveal loses 10% of it.` : `Bid at least the reserve, ${l.reserve}.`;
      };
      amt?.addEventListener("input", showDep);
      showDep();
      $("bz-auc-bid")?.addEventListener("click", () => void seal(l));
    }
    $("bz-auc-x").addEventListener("click", () => toggle(false));
  }

  function recentHtml() {
    const r = view?.recent ?? [];
    if (!r.length) return "";
    return `<h4>Recent lots</h4><ul class="bz-listings">${r
      .map((a) => `<li class="bz-o-empty">${d.goodIcon[a.goodId] ?? "📦"} ${a.qty} ${esc(a.goodName)}: ${a.winner ? `${esc(a.winner)} for <b>${a.price}</b>` : "unsold, sailed on"} · ${a.bids.length} bid${a.bids.length === 1 ? "" : "s"}</li>`)
      .join("")}</ul>`;
  }

  async function seal(l: AuctionLot) {
    if (sending) return;
    const coins = d.me()?.coins ?? 0;
    const amount = Math.floor(Number(($("bz-auc-amt") as HTMLInputElement).value));
    if (!(amount >= l.reserve)) return d.toast(`Bid at least the reserve, ${l.reserve}.`);
    if (amount > coins) return d.toast(`You only have ${coins} coins.`);
    sending = true;
    const salt = randomSalt();
    // Saved before sending, so the reveal works even if the page reloads mid-request.
    saveSealed(l.id, { amount, salt });
    try {
      const commitment = await sha256Hex(`bazaar-bid|${l.id}|${d.player}|${amount}|${salt}`);
      const p = d.cm.getActiveEntity().position;
      const r = await api.bid(l.id, d.player, commitment, depositFor(amount, l.reserve, coins), p.x, p.z);
      view = r.auctions ?? view;
      d.toast("Bid sealed onchain. Nobody, not even the game server, can see it until bidding closes.");
      await d.refreshPurse(true);
    } catch (e) {
      // Only forget the salt if the bid really didn't land: a bid onchain without its salt can't
      // be revealed, and would lose 10% of its deposit.
      const landed = await api
        .auctions(d.player)
        .then((v) => ((view = v), v.lot?.id === l.id && v.lot.bids.some((b) => b.mine)))
        .catch(() => true);
      if (!landed)
        try {
          localStorage.removeItem(sealedKey(l.id));
        } catch {
          /* nothing was saved */
        }
      d.toast(landed ? "Your bid is sealed onchain." : (e as Error).message);
    } finally {
      sending = false;
      render();
    }
  }

  function toggle(on: boolean) {
    open = on;
    $("bz-auction").hidden = !on;
    if (on) render();
  }

  addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT" || d.busy()) return;
    if (e.code === "KeyG" && (atPier || open)) {
      e.preventDefault();
      toggle(!open);
    }
    if (e.code === "Escape" && open) toggle(false);
  });

  void refresh();
  setInterval(() => void refresh(), 5000);

  const dir = new THREE.Vector3();
  let last = 0;
  d.frame.add((_dt, t) => {
    const l = lot();
    ship.visible = !!l;
    if (ship.visible) {
      // A gentle swell.
      ship.position.y = y - 3 + Math.sin(t * 0.8) * 0.25;
      ship.rotation.z = Math.sin(t * 0.6) * 0.012;
      ship.updateMatrixWorld(true);
    }
    if (t - last < 0.2) return;
    last = t;
    const live = !!l && phase(l) === "bidding";
    const p = d.cm.getActiveEntity().position;
    const dist = Math.hypot(PIER.x - p.x, PIER.z - p.z);
    // The beam guides the way; standing in it, it would only block the view of the ship.
    beam.visible = live && dist > REACH;
    const was = atPier;
    atPier = dist < REACH && !d.busy();
    if (open && was !== atPier) render();
    $("bz-pier-prompt").hidden = !(atPier && l && !open);
    if (l) $("bz-pier-text").textContent = phase(l) === "bidding" ? `Bid on ${l.qty} ${l.goodName} (sealed)` : "Watch the bids open";
    const clk = document.getElementById("bz-auc-clock");
    if (clk && l) clk.textContent = clock((phase(l) === "bidding" ? l.bidsClose : l.revealClose) - Date.now());
    const mine = l?.bids.some((b) => b.mine);
    const show = live && dist >= REACH && !mine && !announced.has(l!.id);
    $("bz-ship").hidden = !show;
    if (!show || !l) return;
    d.camera().getWorldDirection(dir);
    const rel = Math.atan2(PIER.x - p.x, PIER.z - p.z) - Math.atan2(dir.x, dir.z);
    $("bz-ship-arrow").style.transform = `rotate(${-rel - Math.PI / 2}rad)`;
    $("bz-ship-title").textContent = `⚓ Cargo ship at Pier 34: ${l.qty} ${l.goodName}`;
    $("bz-ship-sub").textContent = `Sealed bids close in ${clock(l.bidsClose - Date.now())} · reserve ${l.reserve} · ${dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`}`;
  });
}
