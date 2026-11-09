/**
 * Delivery jobs across Manhattan, in the city.
 *
 * Customers (agents with their own NEAR accounts) post orders with bounties locked onchain. The
 * player takes a job from the board, buys the good on Canal Street, and gets it to the customer's
 * door before the deadline: on foot or by bike for free, or by cab or helicopter for a fare that
 * comes out of the bounty. Glowing beacons mark every drop site; the active one leads the way.
 */
import * as THREE from "three";
import { api, type Delivered, type Job, type Order, type PlayerView, type TravelMode } from "../../web/src/api";

export interface JobsDeps {
  scene: THREE.Scene;
  camera: () => THREE.Camera;
  player: string;
  cm: {
    activeMode: string;
    getActiveEntity(): { position: THREE.Vector3 };
    getGroundHeight(x: number, z: number, mode?: string): number;
  };
  frame: Set<(dt: number, t: number) => void>;
  me: () => PlayerView | null;
  refreshPurse: (bump?: boolean) => Promise<unknown>;
  toast: (msg: string) => void;
  burst: (n: number) => void;
  goodIcon: Record<string, string>;
  /** True while a haggle panel is open (the F key belongs to it). */
  busy: () => boolean;
}

const DROP_REACH = 38;
const MODE_OF: Record<string, TravelMode> = { person: "foot", cyclist: "bike", car: "cab", helicopter: "heli" };
const MODE_LABEL: Record<TravelMode, string> = { foot: "on foot", bike: "by bike", cab: "by cab", heli: "by helicopter" };
/** Same fare rule as the server (packages/core orders.ts), for the estimate on the board. */
const fareEstimate = (mode: TravelMode, metres: number) => (mode === "cab" ? Math.round(3 + (metres / 1000) * 4) : mode === "heli" ? Math.round(10 + (metres / 1000) * 10) : 0);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

export function initJobs(d: JobsDeps) {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<button id="bz-jobs-btn" class="bz-card" type="button" title="Delivery jobs (J)">📋 Jobs <b id="bz-jobs-n">0</b></button>
     <section id="bz-board" class="bz-card" hidden>
       <header><div><b>Delivery jobs</b><span>Customers lock the bounty onchain. Deliver before the clock runs out.</span></div><button id="bz-board-x" type="button" aria-label="Close">✕</button></header>
       <ol id="bz-orders"></ol>
       <p class="bz-board-foot">Walk or cycle for free. A cab or helicopter is faster, and its fare comes out of the bounty.</p>
     </section>
     <div id="bz-track" hidden><i id="bz-arrow">➤</i><div><b id="bz-track-title"></b><span id="bz-track-sub"></span></div><time id="bz-track-time"></time></div>
     <div id="bz-drop" hidden><kbd>F</kbd><span id="bz-drop-text"></span></div>
     <div id="bz-site-tags"></div>
     <div id="bz-receipt" hidden></div>`,
  );
  (document.querySelector("#bz-actions") ?? document.querySelector("#bz-hud"))?.appendChild($("bz-jobs-btn"));

  let orders: Order[] = [];
  let job: Job | null = null;
  let skew = 0; // server clock − local clock
  const now = () => Date.now() + skew;
  const active = () => (job ? orders.find((o) => o.id === job!.orderId) ?? null : null);

  // ---------- beacons ----------
  const beamGeo = new THREE.CylinderGeometry(2.2, 2.2, 140, 16, 1, true);
  const ringGeo = new THREE.RingGeometry(5, 7, 32);
  const mats = {
    idle: new THREE.MeshBasicMaterial({ color: "#7fd6ff", transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    active: new THREE.MeshBasicMaterial({ color: "#ffc45c", transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    ring: new THREE.MeshBasicMaterial({ color: "#ffc45c", transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
  };
  const beacons = new Map<string, { group: THREE.Group; beam: THREE.Mesh; ring: THREE.Mesh; tag: HTMLElement; y: number }>();
  function syncBeacons() {
    const ids = new Set(orders.map((o) => o.site));
    for (const [site, b] of beacons)
      if (!ids.has(site)) {
        b.group.removeFromParent();
        b.tag.remove();
        beacons.delete(site);
      }
    for (const o of orders) {
      if (beacons.has(o.site)) continue;
      const y = d.cm.getGroundHeight(o.x, o.z, "person");
      const group = new THREE.Group();
      const beam = new THREE.Mesh(beamGeo, mats.idle);
      beam.position.y = 70;
      const ring = new THREE.Mesh(ringGeo, mats.ring);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.15;
      ring.visible = false;
      group.add(beam, ring);
      group.position.set(o.x, y, o.z);
      d.scene.add(group);
      group.updateMatrixWorld(true); // the city doesn't auto-update matrices
      const tag = document.createElement("div");
      tag.className = "bz-site-tag";
      $("bz-site-tags").appendChild(tag);
      beacons.set(o.site, { group, beam, ring, tag, y });
    }
  }

  // ---------- board ----------
  function playerPos() {
    return d.cm.getActiveEntity().position;
  }
  function renderBoard() {
    $("bz-jobs-n").textContent = String(orders.length);
    const p = playerPos();
    const have = d.me()?.goods ?? {};
    $("bz-orders").innerHTML = orders.length
      ? orders
          .slice()
          .sort((a, b) => a.deadline_ms - b.deadline_ms)
          .map((o) => {
            const dist = Math.hypot(p.x - o.x, p.z - o.z) * 1.25;
            const mine = job?.orderId === o.id;
            return `<li class="${mine ? "mine" : ""} ${o.express ? "express" : ""} ${o.needsLevel ? "locked" : ""}">
              <div class="bz-o-good">${d.goodIcon[o.good_id] ?? "📦"}</div>
              <div class="bz-o-main">
                <b>${esc(o.goodName)} → ${esc(o.customerName)}</b>
                <span>${esc(o.siteName)} · ${km(dist)}${o.express ? ` · <em>express</em>` : ""}${have[o.good_id] ? " · ✓ you have one" : ""}</span>
                <span class="bz-o-fare">cab ≈ ${fareEstimate("cab", dist)} · heli ≈ ${fareEstimate("heli", dist)}</span>
              </div>
              <div class="bz-o-side"><b>${o.bounty}</b><time data-deadline="${o.deadline_ms}">${clock(o.deadline_ms - now())}</time>
                ${mine ? `<span class="bz-o-on">ACTIVE</span>` : o.needsLevel ? `<span class="bz-o-lock" title="Earn street cred to unlock">🔒 Level ${o.needsLevel}</span>` : `<button type="button" data-take="${o.id}">Take</button>`}</div>
            </li>`;
          })
          .join("")
      : `<li class="bz-o-empty">No jobs right now. Customers post new ones every minute or so.</li>`;
    $("bz-orders")
      .querySelectorAll<HTMLButtonElement>("button[data-take]")
      .forEach((b) => b.addEventListener("click", () => void take(b.dataset.take!)));
  }
  async function take(id: string) {
    const p = playerPos();
    try {
      const r = await api.takeOrder(id, d.player, p.x, p.z);
      job = r.job;
      d.toast(`Job taken: ${r.order.goodName} to ${r.order.customerName}, ${r.order.siteName}.`);
      $("bz-board").hidden = true;
      renderBoard();
    } catch (e) {
      d.toast((e as Error).message);
      void refresh();
    }
  }
  const toggleBoard = (open = $("bz-board").hidden) => {
    $("bz-board").hidden = !open;
    if (open) renderBoard();
  };
  $("bz-jobs-btn").addEventListener("click", () => toggleBoard());
  $("bz-board-x").addEventListener("click", () => toggleBoard(false));

  async function refresh() {
    try {
      // The purse decides whether the tracker says "buy one first", so keep it fresh too.
      const [r] = await Promise.all([api.orders(d.player), d.refreshPurse()]);
      skew = r.now - Date.now();
      orders = r.orders;
      job = r.job;
      syncBeacons();
      if (!$("bz-board").hidden) renderBoard();
      else $("bz-jobs-n").textContent = String(orders.length);
    } catch {
      /* the board can wait */
    }
  }
  void refresh();
  setInterval(refresh, 8000);

  // ---------- delivering ----------
  let atDrop = false;
  let delivering = false;
  async function deliver() {
    const o = active();
    if (!o || delivering) return;
    delivering = true;
    const p = playerPos();
    const mode = MODE_OF[d.cm.activeMode] ?? "foot";
    $("bz-drop-text").textContent = "Handing it over…";
    try {
      const r = await api.deliver(o.id, d.player, p.x, p.z, mode);
      job = null;
      showReceipt(o, r);
      d.burst(r.net);
      await Promise.all([d.refreshPurse(true), refresh()]);
    } catch (e) {
      d.toast((e as Error).message);
    } finally {
      delivering = false;
    }
  }
  function showReceipt(o: Order, r: Delivered) {
    $("bz-receipt").innerHTML = `
      <div class="bz-rv">
        <p class="eyebrow">Delivered · settled onchain</p>
        <h3>${esc(o.customerName)} got the ${esc(o.goodName)}</h3>
        <div class="bz-facts">
          <div><span>Bounty</span><b>${r.bounty}</b></div>
          <div><span>${r.fare ? `Fare (${MODE_LABEL[r.mode]})` : "Fare"}</span><b>${r.fare ? `−${r.fare}` : "0"}</b></div>
          <div><span>You earned</span><b>+${r.net}</b></div>
          <div><span>Time</span><b>${clock(r.seconds * 1000)}</b></div>
        </div>
        <p class="bz-verdict ok">${km(r.metres)} ${MODE_LABEL[r.mode]}, ${clock(r.msToSpare)} to spare · <a href="${r.txUrl}" target="_blank" rel="noopener">delivery tx</a></p>
        <button type="button" id="bz-receipt-ok">Back to the streets</button>
      </div>`;
    $("bz-receipt").hidden = false;
    $("bz-receipt-ok").addEventListener("click", () => ($("bz-receipt").hidden = true));
  }

  addEventListener("keydown", (e) => {
    const typing = (e.target as HTMLElement)?.tagName === "INPUT";
    if (typing || d.busy()) return;
    if (e.code === "KeyJ") toggleBoard();
    if (e.code === "KeyF" && atDrop) {
      e.preventDefault();
      void deliver();
    }
    if (e.code === "Escape" && !$("bz-board").hidden) toggleBoard(false);
  });

  // ---------- per frame: beacons, tracker, drop prompt ----------
  const v = new THREE.Vector3();
  const dir = new THREE.Vector3();
  let lastUi = 0;
  d.frame.add((_dt, t) => {
    const cam = d.camera();
    const p = playerPos();
    const a = active();
    for (const [site, b] of beacons) {
      const isActive = a?.site === site;
      b.beam.material = isActive ? mats.active : mats.idle;
      b.ring.visible = isActive;
      const s = 1 + (isActive ? 0.15 * Math.sin(t * 3) : 0);
      b.beam.scale.set(s, 1, s);
      b.ring.scale.setScalar(1 + 0.2 * Math.sin(t * 2.4));
      b.group.updateMatrixWorld(true);
      // Labels only for the active site (and nearby ones), so the screen stays clean.
      const dist = Math.hypot(p.x - b.group.position.x, p.z - b.group.position.z);
      v.set(b.group.position.x, b.y + (dist < 200 ? 12 : 40), b.group.position.z).project(cam);
      const show = v.z < 1 && (isActive || dist < 250) && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      b.tag.style.display = show ? "" : "none";
      if (show) {
        const o = orders.find((x) => x.site === site);
        b.tag.className = `bz-site-tag ${isActive ? "active" : ""}`;
        b.tag.innerHTML = `<b>${esc(o?.siteName ?? site)}</b><span>${isActive ? `deliver here · ${km(dist)}` : `${orders.filter((x) => x.site === site).length} job${orders.filter((x) => x.site === site).length === 1 ? "" : "s"} · ${km(dist)}`}</span>`;
        b.tag.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
      }
    }

    // Tracker and drop prompt, a few times a second.
    if (t - lastUi < 0.15) return;
    lastUi = t;
    $("bz-track").hidden = !a;
    if (!a) {
      atDrop = false;
      $("bz-drop").hidden = true;
      return;
    }
    const dx = a.x - p.x;
    const dz = a.z - p.z;
    const dist = Math.hypot(dx, dz);
    cam.getWorldDirection(dir);
    const rel = Math.atan2(dx, dz) - Math.atan2(dir.x, dir.z);
    $("bz-arrow").style.transform = `rotate(${-rel - Math.PI / 2}rad)`;
    const left = a.deadline_ms - now();
    const has = (d.me()?.goods[a.good_id] ?? 0) > 0;
    $("bz-track-title").textContent = `${a.goodName} → ${a.customerName}`;
    $("bz-track-sub").textContent = has ? `${a.siteName} · ${km(dist * 1.25)}` : `Buy a ${a.goodName} on Canal St first · ${a.siteName}`;
    $("bz-track-time").textContent = clock(left);
    $("bz-track").classList.toggle("late", left < 60_000);
    $("bz-track").classList.toggle("need", !has);
    atDrop = dist < DROP_REACH && has && !d.busy();
    $("bz-drop").hidden = !atDrop;
    if (atDrop && !delivering) $("bz-drop-text").textContent = `Deliver ${a.goodName} to ${a.customerName} (+${a.bounty})`;
    if (!$("bz-board").hidden)
      for (const el of $("bz-orders").querySelectorAll<HTMLElement>("time[data-deadline]")) el.textContent = clock(Number(el.dataset.deadline) - now());
  });

  return { refresh };
}
