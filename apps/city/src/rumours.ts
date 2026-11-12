/**
 * The rumour network: informants around the city sell tips about the next few minutes.
 *
 * Two lurk off Canal Street, two further out (Bryant Park, Times Square). Each wears its public
 * record over its head: how many tips came true and how many were lies, as checked by the
 * contract. A tip's words come from the private model; only its hash goes onchain until the check
 * time, when the contract checks it against the merchant's real stock. A lie is refunded.
 */
import * as THREE from "three";
import { bindStation } from "./station";
import { api, type InformantView, type PlayerView, type RumoursView, type TipView } from "../../web/src/api";
import { buildStall, type StallLook } from "../../web/src/scene";

export interface RumourDeps {
  scene: THREE.Scene;
  camera: () => THREE.Camera;
  player: string;
  cm: { activeMode: string; getActiveEntity(): { position: THREE.Vector3 }; getGroundHeight(x: number, z: number, mode?: string): number; isPointOnSidewalk(x: number, z: number): boolean };
  frame: Set<(dt: number, t: number) => void>;
  me: () => PlayerView | null;
  refreshPurse: (bump?: boolean) => Promise<unknown>;
  toast: (msg: string) => void;
  busy: () => boolean;
}

const LOOK: Record<string, StallLook> = {
  vex: { id: "vex", cloth: "#4b2a63", cloth2: "#c9a2e8", robe: "#3a1f4d", skin: "#c58f6a", hat: "hood", good: "lamp" },
  pete: { id: "pete", cloth: "#55606b", cloth2: "#c7cfd6", robe: "#5b6470", skin: "#e0b08c", hat: "cap", good: "lamp" },
  deacon: { id: "deacon", cloth: "#1f2a38", cloth2: "#e6e1d3", robe: "#1c1c22", skin: "#6b4a34", hat: "wrap", good: "lamp" },
  lulu: { id: "lulu", cloth: "#b8325a", cloth2: "#ffd0dd", robe: "#8c2348", skin: "#d9a982", hat: "cap", good: "lamp" },
};
const TALK_REACH = 5;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const record = (i: InformantView) => (i.sold ? `${i.truths} ✓ · ${i.lies} ✗${i.hidden ? ` · ${i.hidden} hidden` : ""}` : "no record yet");

export function initRumours(d: RumourDeps) {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<button id="bz-inf-prompt" type="button" hidden><kbd>F</kbd><span id="bz-inf-text"></span></button>
     <aside id="bz-rumour" class="bz-card" hidden></aside>`,
  );
  // Pending tips sit in the HUD, under the purse and street cred.
  (document.getElementById("bz-hud") ?? document.body).insertAdjacentHTML("beforeend", `<button id="bz-tips-chip" class="bz-card" type="button" hidden></button>`);

  type Figure = { id: string; pos: THREE.Vector3; root: THREE.Object3D; tag: HTMLElement };
  const figures: Figure[] = [];
  let view: RumoursView | null = null;
  let open: string | null = null;
  let near: string | null = null;
  let buying = false;
  /** The tip just bought, kept on screen across refreshes until the panel closes. */
  let fresh = "";
  const seen = new Set<string>();

  /** Stand the informant on the nearest bit of sidewalk to its spot. */
  function standAt(x: number, z: number) {
    for (let r = 0; r < 30; r += 1.5)
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (d.cm.isPointOnSidewalk(px, pz)) return { x: px, z: pz };
      }
    return { x, z };
  }

  function place(list: InformantView[]) {
    for (const i of list) {
      if (figures.some((f) => f.id === i.id)) continue;
      const s = standAt(i.x, i.z);
      const y = d.cm.getGroundHeight(s.x, s.z, "person");
      // Only the figure: an informant has no stall.
      const st = buildStall(LOOK[i.id] ?? LOOK.pete);
      const root = st.merchant.root;
      root.removeFromParent();
      root.position.set(s.x, y, s.z);
      root.rotation.y = Math.random() * Math.PI * 2;
      d.scene.add(root);
      root.updateMatrixWorld(true);
      const tag = document.createElement("div");
      tag.className = "bz-tag bz-inf-tag";
      $("bz-tags")?.appendChild(tag);
      figures.push({ id: i.id, pos: new THREE.Vector3(s.x, y, s.z), root, tag });
    }
  }

  function renderTags() {
    for (const f of figures) {
      const i = view?.informants.find((x) => x.id === f.id);
      if (i) f.tag.innerHTML = `<b>🕵️ ${esc(i.name)}</b><span>Tips ${i.price} · ${record(i)}</span>`;
    }
  }

  async function refresh() {
    try {
      view = await api.rumours(d.player);
    } catch {
      return;
    }
    place(view.informants);
    renderTags();
    announce(view.tips);
    renderChip();
    if (open && !buying) renderPanel(open);
  }

  /** When a tip resolves, say how it went (once). */
  function announce(tips: TipView[]) {
    for (const t of tips) {
      if (t.status === "pending") continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (Date.now() - t.checkMs > 10 * 60_000) continue;
      if (t.status === "true") d.toast(`${t.informant}'s tip came true (checked onchain). Worth the ${t.price}.`);
      else if (t.status === "void") d.toast(`${t.informant}'s tip didn't count: you traded with that merchant before the check.`);
      else if (t.status === "false") {
        d.toast(`${t.informant} lied! The contract caught it and refunded your ${t.price} coins.`);
        void d.refreshPurse(true);
      } else d.toast(`${t.informant}'s tip was never revealed: refunded, and it's on their record.`);
    }
  }

  function renderChip() {
    const pending = view?.tips.filter((t) => t.status === "pending") ?? [];
    const chip = $("bz-tips-chip");
    chip.hidden = !pending.length;
    if (pending.length) chip.textContent = `🕵️ ${pending.length} tip${pending.length > 1 ? "s" : ""} · next check ${clock(Math.min(...pending.map((t) => t.checkMs)) - Date.now())}`;
  }

  function tipHtml(t: TipView) {
    const badge = t.status === "pending" ? `⏳ checks in ${clock(t.checkMs - Date.now())}` : t.status === "true" ? "✓ came true" : t.status === "false" ? `✗ a lie (stock was ${t.observed}); refunded` : t.status === "void" ? "void: you traded with that merchant" : "hidden; refunded";
    return `<li class="bz-o-empty"><b>${esc(t.informant)}</b> · ${badge}${t.text ? `<br><i>“${esc(t.text)}”</i>` : ""}${t.plain ? `<br><span class="bz-dim">${esc(t.plain)}</span>` : ""}</li>`;
  }

  function renderPanel(id: string) {
    const i = view?.informants.find((x) => x.id === id);
    if (!i) return;
    const mine = (view?.tips ?? []).filter((t) => t.informant === i.name);
    const coins = d.me()?.coins ?? 0;
    $("bz-rumour").innerHTML = `
      <header><div><h2>🕵️ ${esc(i.name)}</h2><p>${esc(i.where)}</p></div><button type="button" id="bz-rum-x" aria-label="Close">✕</button></header>
      <p class="bz-note">Onchain record: <b>${i.truths}</b> true · <b>${i.lies}</b> lies${i.hidden ? ` · ${i.hidden} never revealed` : ""} of ${i.sold} sold. Honesty is secret; the record is all you get.</p>
      <p class="bz-note">A tip is about the next 4 minutes. Only its hash goes onchain now. When the clock runs out the contract checks it against the merchant's real stock: a true tip is paid, a lie is refunded.</p>
      <button type="button" id="bz-rum-buy" ${coins < i.price ? "disabled" : ""}>Buy a tip · ${i.price} coins</button>
      <div id="bz-rum-new">${fresh}</div>
      ${mine.length ? `<h4>Your tips from ${esc(i.name)}</h4><ul class="bz-listings">${mine.map(tipHtml).join("")}</ul>` : ""}`;
    $("bz-rum-x").addEventListener("click", close);
    $("bz-rum-buy").addEventListener("click", () => void buy(i));
  }

  async function buy(i: InformantView) {
    if (buying) return;
    buying = true;
    ($("bz-rum-buy") as HTMLButtonElement).disabled = true;
    $("bz-rum-new").innerHTML = `<p class="bz-note">${esc(i.name)} leans in…</p>`;
    try {
      const p = d.cm.getActiveEntity().position;
      const r = await api.buyTip(i.id, d.player, p.x, p.z);
      fresh = `<blockquote class="bz-whisper">“${esc(r.tip.text)}”</blockquote><p class="bz-note">${esc(r.tip.plain)} Checked onchain in ${clock(r.tip.checkMs - Date.now())}. <a href="${r.txUrl}" target="_blank" rel="noopener">sealed tx</a></p>`;
      $("bz-rum-new").innerHTML = fresh;
      await d.refreshPurse(true);
      view = await api.rumours(d.player).catch(() => view);
      renderChip();
    } catch (e) {
      $("bz-rum-new").innerHTML = "";
      d.toast((e as Error).message);
    } finally {
      buying = false;
      const b = document.getElementById("bz-rum-buy") as HTMLButtonElement | null;
      if (b) b.disabled = false;
    }
  }

  function close() {
    open = null;
    near = null;
    fresh = "";
    $("bz-rumour").hidden = true;
  }

  bindStation($("bz-inf-prompt"), "KeyF", () => {
    if (d.busy() || !near || open) return false;
    open = near;
    $("bz-inf-prompt").hidden = true;
    $("bz-rumour").hidden = false;
    renderPanel(near);
    return true;
  });
  addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT" || d.busy()) return;
    if (e.code === "Escape" && open) close();
  });
  $("bz-tips-chip").addEventListener("click", () => {
    // Show the most recent tip's informant.
    const t = view?.tips[0];
    const i = t && view?.informants.find((x) => x.name === t.informant);
    if (!i) return;
    open = i.id;
    $("bz-rumour").hidden = false;
    renderPanel(i.id);
  });

  void refresh();
  setInterval(() => void refresh(), 8000);

  const v = new THREE.Vector3();
  let last = 0;
  d.frame.add((_dt, t) => {
    const cam = d.camera();
    const p = d.cm.getActiveEntity().position;
    let best: string | null = null;
    for (const f of figures) {
      const dist = p.distanceTo(f.pos);
      v.copy(f.pos).setY(f.pos.y + 2.6).project(cam);
      const show = v.z < 1 && dist < 90 && !open && !d.busy();
      f.tag.style.display = show ? "" : "none";
      if (show) f.tag.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
      if (d.cm.activeMode === "person" && dist < TALK_REACH) best = f.id;
      // Informants fidget and glance around.
      f.root.rotation.y += Math.sin(t * 0.7 + f.pos.x) * 0.002;
    }
    if (t - last > 0.25) {
      last = t;
      for (const f of figures) f.root.updateMatrixWorld(true);
      renderChip();
    }
    if (best !== near) {
      near = best;
      const i = view?.informants.find((x) => x.id === near);
      $("bz-inf-prompt").hidden = !i || !!open || d.busy();
      if (i) $("bz-inf-text").textContent = `Talk to ${i.name} (tips ${i.price})`;
    }
  });
}
