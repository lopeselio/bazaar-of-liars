/**
 * Price boards and trade routes: the map is the market.
 *
 * Auntie Wu's board at the Pier 34 docks sells goods cheap; customers uptown post what they'll pay
 * outside their doors, more the further they are from Canal Street. Buy low, carry it across
 * town, sell high. Every trade settles onchain: Wu never sells below her cost, and a buyer pays
 * exactly what it signed for. A HUD chip shows the best spread right now and can guide you there.
 */
import * as THREE from "three";
import { bindStation } from "./station";
import { api, type BoardView, type BoardsView, type PlayerView } from "../../web/src/api";

export interface RouteDeps {
  scene: THREE.Scene;
  camera: () => THREE.Camera;
  player: string;
  cm: { activeMode: string; getActiveEntity(): { position: THREE.Vector3 }; getGroundHeight(x: number, z: number, mode?: string): number };
  frame: Set<(dt: number, t: number) => void>;
  me: () => PlayerView | null;
  refreshPurse: (bump?: boolean) => Promise<unknown>;
  toast: (msg: string) => void;
  burst: (n: number) => void;
  goodIcon: Record<string, string>;
  goodName: (id: string) => string;
  busy: () => boolean;
}

const NEAR_BOARD = 8;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const dist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/** A street sign on a post: orange where you buy, green where you sell. */
function buildSign(kind: "sells" | "buys") {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 8), new THREE.MeshStandardMaterial({ color: "#2b2b2b" }));
  post.position.y = 1.3;
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 1, 0.08),
    new THREE.MeshStandardMaterial({ color: kind === "sells" ? "#d9822b" : "#3f9d63", emissive: kind === "sells" ? "#5a2e08" : "#0e3a20" }),
  );
  board.position.y = 2.5;
  g.add(post, board);
  return g;
}

export function initRoutes(d: RouteDeps) {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<button id="bz-board-prompt" type="button" hidden><kbd>T</kbd><span id="bz-board-text"></span></button>
     <aside id="bz-boardp" class="bz-card" hidden></aside>
     <div id="bz-guide" hidden><i id="bz-guide-arrow">➤</i><div><b id="bz-guide-title"></b><span id="bz-guide-sub"></span></div></div>`,
  );
  (document.getElementById("bz-hud") ?? document.body).insertAdjacentHTML("beforeend", `<button id="bz-route-chip" class="bz-card" type="button" hidden></button>`);

  type Sign = { id: string; pos: THREE.Vector3; tag: HTMLElement };
  const signs: Sign[] = [];
  let view: BoardsView | null = null;
  let open: string | null = null;
  let near: string | null = null;
  let guiding = false;
  let trading = false;

  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(2.4, 2.4, 140, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: "#7fe0a5", transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  );
  beam.visible = false;
  d.scene.add(beam);

  function place(boards: BoardView[]) {
    for (const b of boards) {
      if (signs.some((s) => s.id === b.id)) continue;
      const y = d.cm.getGroundHeight(b.x, b.z, "person");
      const sign = buildSign(b.kind);
      sign.position.set(b.x, y, b.z);
      d.scene.add(sign);
      sign.updateMatrixWorld(true);
      const tag = document.createElement("div");
      tag.className = "bz-tag bz-board-tag";
      $("bz-tags")?.appendChild(tag);
      signs.push({ id: b.id, pos: new THREE.Vector3(b.x, y, b.z), tag });
    }
  }

  const priceLine = (b: BoardView) =>
    b.goods.map((g) => `${d.goodIcon[g] ?? ""} ${b.prices[g] ?? "–"}`).join(" · ");

  function renderTags() {
    for (const s of signs) {
      const b = view?.boards.find((x) => x.id === s.id);
      if (b) s.tag.innerHTML = `<b>${b.kind === "sells" ? "🏷️ Sells" : "💰 Buys"} · ${esc(b.name)}</b><span>${priceLine(b)}</span>`;
    }
  }

  /** Where the best route sends you next: to buy if you don't have the good, else to sell. */
  function target() {
    const r = view?.best;
    if (!r || !view) return null;
    const has = (d.me()?.goods[r.goodId] ?? 0) > 0;
    const b = view.boards.find((x) => x.id === (has ? r.sellAt : r.buyAt));
    return b ? { b, has, r } : null;
  }

  function renderChip() {
    const chip = $("bz-route-chip");
    const r = view?.best;
    chip.hidden = !r;
    if (!r || !view) return;
    const at = (id: string) => view!.boards.find((b) => b.id === id)?.district ?? id;
    chip.innerHTML = `<i aria-hidden="true">📈</i><span>${d.goodIcon[r.goodId] ?? ""} ${esc(at(r.buyAt))} ${r.buy} → ${esc(at(r.sellAt))} ${r.sell}</span><b>+${r.profit}</b>${guiding ? `<em>guiding</em>` : ""}`;
    chip.classList.toggle("guiding", guiding);
    chip.title = guiding ? "Click to stop guiding" : "Best trade route right now. Click to be guided there.";
  }

  async function refresh() {
    try {
      view = await api.boards();
    } catch {
      return;
    }
    place(view.boards);
    renderTags();
    renderChip();
    if (open && !trading) renderPanel(open);
  }

  function renderPanel(id: string) {
    const b = view?.boards.find((x) => x.id === id);
    if (!b) return;
    const me = d.me();
    const rows = b.goods
      .map((g) => {
        const price = b.prices[g];
        const have = me?.goods[g] ?? 0;
        const can = price !== null && (b.kind === "sells" ? (me?.coins ?? 0) >= price : have > 0);
        const why = price === null ? (b.kind === "sells" ? "kept for merchants" : "had enough today") : b.kind === "sells" ? `${b.stock[g]} in stock` : `you have ${have}`;
        return `<li><span>${d.goodIcon[g] ?? ""} ${esc(d.goodName(g))}<br><span class="bz-dim">${why}</span></span><b>${price ?? "–"}</b><button type="button" data-good="${g}" ${can ? "" : "disabled"}>${b.kind === "sells" ? "Buy 1" : "Sell 1"}</button></li>`;
      })
      .join("");
    $("bz-boardp").innerHTML = `
      <header><div><h2>${b.kind === "sells" ? "🏷️" : "💰"} ${esc(b.name)}</h2><p>${esc(b.district)} · ${b.kind === "sells" ? "sells at posted prices" : "buys at posted prices"}</p></div><button type="button" id="bz-board-x" aria-label="Close">✕</button></header>
      <p class="bz-note">${b.kind === "sells" ? "Auntie Wu sells cheap when her stock is high. The contract won't let her sell below what it cost her." : "Buyers further from Canal Street pay more, and less with each one they've bought today. The buyer signs for every purchase itself."}</p>
      <ul class="bz-listings">${rows}</ul>`;
    $("bz-board-x").addEventListener("click", close);
    $("bz-boardp")
      .querySelectorAll<HTMLButtonElement>("button[data-good]")
      .forEach((btn) => btn.addEventListener("click", () => void trade(b, btn.dataset.good!)));
  }

  async function trade(b: BoardView, goodId: string) {
    if (trading) return;
    trading = true;
    try {
      const p = d.cm.getActiveEntity().position;
      const r = await api.boardTrade(b.id, d.player, goodId, p.x, p.z, b.prices[goodId] ?? 0);
      if (r.boards) view = r.boards;
      d.toast(b.kind === "sells" ? `Bought ${d.goodName(goodId)} for ${r.price}. Settled onchain.` : `Sold ${d.goodName(goodId)} to ${b.name} for ${r.price}. Settled onchain.`);
      if (b.kind === "buys") d.burst(Math.max(3, Math.round(r.price / 10)));
      await d.refreshPurse(true);
    } catch (e) {
      d.toast((e as Error).message);
      // A moved price: show the new one.
      view = await api.boards().catch(() => view);
    } finally {
      trading = false;
      renderTags();
      renderChip();
      if (open) renderPanel(open);
    }
  }

  function close() {
    open = null;
    near = null; // re-evaluated next frame, which brings the prompt back
    $("bz-boardp").hidden = true;
  }

  bindStation($("bz-board-prompt"), "KeyT", () => {
    if (d.busy() || !near || open) return false;
    open = near;
    $("bz-board-prompt").hidden = true;
    $("bz-boardp").hidden = false;
    renderPanel(near);
    return true;
  });
  addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT" || d.busy()) return;
    if (e.code === "Escape" && open) close();
  });
  $("bz-route-chip").addEventListener("click", () => {
    guiding = !guiding;
    renderChip();
    if (guiding) {
      const t = target();
      if (t) d.toast(t.has ? `Take your ${d.goodName(t.r.goodId)} to ${t.b.name} (${t.b.district}): they pay ${t.r.sell}.` : `Buy ${d.goodName(t.r.goodId)} at ${t.b.name} for ${t.r.buy}, then sell it uptown for ${t.r.sell}.`);
    }
  });

  void refresh();
  setInterval(() => void refresh(), 10_000);

  const v = new THREE.Vector3();
  const dir = new THREE.Vector3();
  let last = 0;
  d.frame.add((_dt, t) => {
    const cam = d.camera();
    const p = d.cm.getActiveEntity().position;
    let best: string | null = null;
    for (const s of signs) {
      const m = p.distanceTo(s.pos);
      v.copy(s.pos).setY(s.pos.y + 3.4).project(cam);
      const show = v.z < 1 && m < 120 && !open && !d.busy();
      s.tag.style.display = show ? "" : "none";
      if (show) s.tag.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
      if (d.cm.activeMode === "person" && m < NEAR_BOARD) best = s.id;
    }
    if (best !== near) {
      near = best;
      const b = view?.boards.find((x) => x.id === near);
      $("bz-board-prompt").hidden = !b || !!open || d.busy();
      if (b) $("bz-board-text").textContent = `${b.kind === "sells" ? "Buy at" : "Sell to"} ${b.name}`;
    }
    if (t - last < 0.2) return;
    last = t;
    const tg = guiding ? target() : null;
    beam.visible = !!tg;
    $("bz-guide").hidden = !tg;
    if (!tg) return;
    const y = d.cm.getGroundHeight(tg.b.x, tg.b.z, "person");
    beam.position.set(tg.b.x, y + 70, tg.b.z);
    beam.updateMatrixWorld(true);
    const m = Math.hypot(tg.b.x - p.x, tg.b.z - p.z);
    d.camera().getWorldDirection(dir);
    const rel = Math.atan2(tg.b.x - p.x, tg.b.z - p.z) - Math.atan2(dir.x, dir.z);
    $("bz-guide-arrow").style.transform = `rotate(${-rel - Math.PI / 2}rad)`;
    $("bz-guide-title").textContent = tg.has ? `📈 Sell ${d.goodName(tg.r.goodId)} to ${tg.b.name}: ${tg.r.sell}` : `📈 Buy ${d.goodName(tg.r.goodId)} at ${tg.b.name}: ${tg.r.buy}`;
    $("bz-guide-sub").textContent = `${tg.b.district} · ${dist(m)}${m > 1500 ? " · quicker to drive or cycle" : ""}`;
  });
}
