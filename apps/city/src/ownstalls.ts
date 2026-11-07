/**
 * Player-owned stalls on Canal Street.
 *
 * Four licence slots stand further along the street. At street cred level 3 a player can buy a
 * licence (150 coins, burned), stock the stall with goods they own and set prices. While they're
 * away, agents buy from it (each purchase signed by the agent and settled onchain) and the
 * takings wait in the till. Coming back, the player sees what it earned and collects.
 *
 * Each licence is a deed: a NEP-171 NFT the owner holds (and sees in a NEAR wallet). An owner can
 * put the deed up for sale; any player without a stall can buy it, no street cred needed.
 */
import * as THREE from "three";
import { api, type OwnStall, type PlayerView, type StallsView } from "../../web/src/api";
import { buildStall, type StallLook } from "../../web/src/scene";

export interface OwnStallsDeps {
  scene: THREE.Scene;
  camera: () => THREE.Camera;
  player: string;
  cm: { activeMode: string; getActiveEntity(): { position: THREE.Vector3 }; resetInput(): void; teleportActiveTo(x: number, z: number, heading?: number): void };
  frame: Set<(dt: number, t: number) => void>;
  /** A sidewalk spot along Canal Street at fraction t, and the direction to the road. */
  spot: (t: number) => { x: number; z: number; toRoad: THREE.Vector2 };
  ground: (x: number, z: number) => number;
  me: () => PlayerView | null;
  refreshPurse: (bump?: boolean) => Promise<unknown>;
  toast: (msg: string) => void;
  burst: (n: number) => void;
  goodIcon: Record<string, string>;
  goodName: (id: string) => string;
  goodValue: (id: string) => number;
  busy: () => boolean;
}

/** Further along Canal Street than the merchants (who stand at 0.28–0.72). */
const SLOT_T: Record<string, number> = { "corner-1": 0.82, "corner-2": 0.88, "corner-3": 0.94, "corner-4": 0.99 };
const REACH = 4.5;
const LOOK = {
  free: { id: "free", cloth: "#5b5246", cloth2: "#9c8f7a", robe: "#333", skin: "#000", hat: "cap", good: "lamp" },
  mine: { id: "mine", cloth: "#d9a21b", cloth2: "#fff1c4", robe: "#333", skin: "#000", hat: "cap", good: "saffron" },
  theirs: { id: "theirs", cloth: "#3e6fb0", cloth2: "#d8e6f7", robe: "#333", skin: "#000", hat: "cap", good: "rug" },
} satisfies Record<string, StallLook>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function initOwnStalls(d: OwnStallsDeps) {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="bz-own-prompt" hidden><kbd>F</kbd><span id="bz-own-prompt-text"></span></div>
     <aside id="bz-own" class="bz-card" hidden></aside>
     <div id="bz-away" hidden></div>`,
  );

  type Slot = { slot: string; kind: keyof typeof LOOK; group: THREE.Group | null; pos: THREE.Vector3; front: THREE.Vector3; tag: HTMLElement };
  const slots: Slot[] = Object.entries(SLOT_T).map(([slot, t]) => {
    const s = d.spot(t);
    const y = d.ground(s.x, s.z);
    const tag = document.createElement("div");
    tag.className = "bz-tag bz-own-tag";
    $("bz-tags")?.appendChild(tag);
    return { slot, kind: "free", group: null, pos: new THREE.Vector3(s.x, y, s.z), front: new THREE.Vector3(s.x + s.toRoad.x * 1.8, y, s.z + s.toRoad.y * 1.8), tag };
  });
  /** (Re)build a slot's stall in its owner's colours. Nobody stands behind it: the owner is out. */
  function dress(s: Slot, kind: Slot["kind"]) {
    if (s.group && s.kind === kind) return;
    s.group?.removeFromParent();
    const st = buildStall(LOOK[kind]);
    st.merchant.root.visible = false;
    st.lantern.removeFromParent(); // no new lights after the city boots
    const toRoad = new THREE.Vector2(s.front.x - s.pos.x, s.front.z - s.pos.z);
    st.group.position.copy(s.pos);
    st.group.rotation.y = Math.atan2(toRoad.x, toRoad.y);
    d.scene.add(st.group);
    st.group.updateMatrixWorld(true);
    s.group = st.group;
    s.kind = kind;
  }

  let view: StallsView | null = null;
  const mine = () => view?.mine ?? null;

  function renderTags() {
    if (!view) return;
    for (const s of slots) {
      const v = view.slots.find((x) => x.slot === s.slot);
      const kind = !v?.owner ? "free" : v.mine ? "mine" : "theirs";
      dress(s, kind);
      const forSale = v?.listings.reduce((n, l) => n + l.qty, 0) ?? 0;
      s.tag.innerHTML =
        kind === "free"
          ? `<b>Stall for licence</b><span>Level ${view.licenceLevel} · ${view.licencePrice} coins</span>`
          : kind === "mine"
            ? `<b>Your stall</b><span>${forSale} for sale · till ${mine()?.till ?? 0}${v?.ask ? ` · deed listed at ${v.ask}` : ""}</span>`
            : `<b>${esc(v!.owner!)}'s stall</b><span>${v?.ask ? `📜 Deed for sale · ${v.ask}` : `${forSale} for sale · ${v!.sold} sold`}</span>`;
    }
  }

  async function refresh(visit = false) {
    try {
      view = await api.stalls(d.player, visit);
      renderTags();
      if (visit && view.away && view.away.sold > 0) showAway(view.away, view.mine!);
      if (!$("bz-own").hidden && open) renderPanel(open);
    } catch {
      /* the street office can wait */
    }
  }
  void refresh(true);
  setInterval(() => void refresh(), 10_000);

  function showAway(a: { sold: number; earned: number }, st: OwnStall) {
    $("bz-away").innerHTML = `
      <div class="bz-rv">
        <p class="eyebrow">While you were away</p>
        <h3>Your stall sold <b>${a.sold}</b> and earned <b>${a.earned}</b> coins</h3>
        <p class="bz-verdict ok">${st.till} coins are waiting in the till. Walk to your stall and press F to collect.</p>
        <button type="button" id="bz-away-ok">Let's go</button>
      </div>`;
    $("bz-away").hidden = false;
    d.burst(a.earned);
    $("bz-away-ok").addEventListener("click", () => ($("bz-away").hidden = true));
  }

  // ---------- the stall panel ----------
  let open: Slot | null = null;
  const act = async (f: () => Promise<{ txUrl: string; stalls: StallsView }>, done: string) => {
    try {
      const r = await f();
      view = r.stalls;
      renderTags();
      d.toast(done);
      await d.refreshPurse(true);
      if (open) renderPanel(open);
    } catch (e) {
      d.toast((e as Error).message);
    }
  };

  function renderPanel(s: Slot) {
    const v = view?.slots.find((x) => x.slot === s.slot);
    const me = d.me();
    const p = $("bz-own");
    const head = `<header><div><h2>${v?.mine ? "Your stall" : v?.owner ? `${esc(v.owner)}'s stall` : "A stall for licence"}</h2><p>Canal Street · ${s.slot}</p></div><button type="button" id="bz-own-x" aria-label="Close">✕</button></header>`;
    if (!v?.owner) {
      const lvl = me?.cred?.level ?? 1;
      const hasOne = !!mine();
      const why = hasOne ? "You already have a stall." : lvl < view!.licenceLevel ? `Reach street cred level ${view!.licenceLevel} first (you're level ${lvl}).` : (me?.coins ?? 0) < view!.licencePrice ? `You need ${view!.licencePrice} coins.` : "";
      p.innerHTML = `${head}
        <p class="bz-note">Own this stall. Stock it with goods you own and set your prices. While you're away, rival traders and customers buy from it, and the takings wait in the till. The street keeps 10% of each sale.</p>
        <p class="bz-note">📜 The licence is a deed: an NFT on NEAR that you own and can sell later.</p>
        <button type="button" id="bz-licence" ${why ? "disabled" : ""}>Buy the licence · ${view!.licencePrice} coins</button>
        ${why ? `<p class="bz-note">${why}</p>` : ""}`;
      $("bz-licence")?.addEventListener("click", () => void act(() => api.buyLicence(d.player, s.slot), "The stall is yours. Stock it and set your prices."));
    } else if (v.mine) {
      const st = mine()!;
      const goods = Object.entries(me?.goods ?? {}).filter(([, n]) => n > 0);
      p.innerHTML = `${head}
        <div class="bz-agent-facts"><div><span>Till</span><b>${st.till}</b></div><div><span>Sold</span><b>${st.sold}</b></div><div><span>Earned</span><b>${st.earned}</b></div><div><span>On sale</span><b>${st.listings.reduce((n, l) => n + l.qty, 0)}</b></div></div>
        <button type="button" id="bz-collect" ${st.till ? "" : "disabled"}>Collect ${st.till} coins</button>
        <h4>On your stall</h4>
        <ul class="bz-listings">${
          st.listings.filter((l) => l.qty > 0).map((l) => `<li><span>${d.goodIcon[l.good_id] ?? "📦"} ${esc(d.goodName(l.good_id))} × ${l.qty}</span>
            <span class="bz-price"><button type="button" data-price="${l.good_id}" data-d="-5">−5</button><b>${l.price}</b><button type="button" data-price="${l.good_id}" data-d="5">+5</button></span>
            <button type="button" data-withdraw="${l.good_id}">Take back</button></li>`).join("") || `<li class="bz-o-empty">Nothing on sale yet.</li>`
        }</ul>
        <h4>Put out from your goods</h4>
        <ul class="bz-listings">${
          goods.map(([g, n]) => `<li><span>${d.goodIcon[g] ?? "📦"} ${esc(d.goodName(g))} (you have ${n})</span>
            <span class="bz-price">at <input type="number" min="1" max="500" value="${st.listings.find((l) => l.good_id === g)?.price ?? Math.round(d.goodValue(g) * 0.9)}" data-for="${g}" /></span>
            <button type="button" data-stock="${g}">Put 1 out</button></li>`).join("") || `<li class="bz-o-empty">You have no goods. Buy some from the merchants.</li>`
        }</ul>
        <p class="bz-note">Traders snap up anything priced under street value. Customers whose deliveries nobody brought buy too, up to their bounty.</p>
        ${deedHtml(st)}`;
      $("bz-deed-list")?.addEventListener("click", () => {
        const price = Math.floor(Number(p.querySelector<HTMLInputElement>("#bz-deed-price")!.value));
        void act(() => api.listDeed(d.player, price), `Your deed is on the market at ${price}.`);
      });
      $("bz-deed-unlist")?.addEventListener("click", () => void act(() => api.unlistDeed(d.player), "Your deed is off the market."));
      $("bz-collect").addEventListener("click", () => void act(() => api.collectTill(d.player), `Collected ${st.till} coins.`));
      p.querySelectorAll<HTMLButtonElement>("button[data-price]").forEach((b) =>
        b.addEventListener("click", () => {
          const l = st.listings.find((x) => x.good_id === b.dataset.price)!;
          const price = Math.max(1, Math.min(500, l.price + Number(b.dataset.d)));
          void act(() => api.stockStall(d.player, l.good_id, 0, price), `${d.goodName(l.good_id)} now ${price}.`);
        }),
      );
      p.querySelectorAll<HTMLButtonElement>("button[data-withdraw]").forEach((b) =>
        b.addEventListener("click", () => void act(() => api.withdrawStock(d.player, b.dataset.withdraw!, 1), "Took one back.")),
      );
      p.querySelectorAll<HTMLButtonElement>("button[data-stock]").forEach((b) =>
        b.addEventListener("click", () => {
          const g = b.dataset.stock!;
          const price = Number(p.querySelector<HTMLInputElement>(`input[data-for="${g}"]`)!.value);
          void act(() => api.stockStall(d.player, g, 1, price), `${d.goodName(g)} is on your stall at ${price}.`);
        }),
      );
    } else {
      p.innerHTML = `${head}
        <ul class="bz-listings">${v.listings.map((l) => `<li><span>${d.goodIcon[l.good_id] ?? "📦"} ${esc(d.goodName(l.good_id))} × ${l.qty}</span><b>${l.price}</b></li>`).join("") || `<li class="bz-o-empty">Nothing on sale.</li>`}</ul>
        <p class="bz-note">Another player's stall. Agents buy from it while they're away.</p>
        ${v.ask ? buyDeedHtml(v.ask) : ""}
        ${v.deedUrl ? `<p class="bz-note"><a href="${v.deedUrl}" target="_blank" rel="noopener">📜 See the deed onchain</a></p>` : ""}`;
      const price = v.ask;
      $("bz-deed-buy")?.addEventListener("click", () => price && void act(() => api.buyDeed(d.player, s.slot, price), `The deed is yours: ${s.slot} is your stall now. Stock it and set your prices.`));
    }
    $("bz-own-x").addEventListener("click", close);
  }
  /** The owner's deed: list it, reprice it, or take it off the market. */
  function deedHtml(st: OwnStall) {
    const tax = view?.deedTax ?? 5;
    const link = st.deedUrl ? ` <a href="${st.deedUrl}" target="_blank" rel="noopener">See it onchain</a>.` : "";
    return `<h4>📜 Your deed</h4>
      <p class="bz-note">This stall's deed is an NFT you own (token <b>${esc(st.slot)}</b>), so it shows in a NEAR wallet.${link}</p>
      ${
        st.ask
          ? `<p class="bz-note">On the market at <b>${st.ask}</b> coins. If it sells you keep ${st.ask - Math.floor((st.ask * tax) / 100)}, and your stock and till come back to you.</p>
             <div class="bz-price">Reprice at <input type="number" id="bz-deed-price" min="1" max="${view?.maxDeedPrice ?? 5000}" value="${st.ask}" /> <button type="button" id="bz-deed-list">Reprice</button> <button type="button" id="bz-deed-unlist">Take it off the market</button></div>`
          : `<p class="bz-note">Sell it to another player. The buyer gets the empty stall; your stock and till come back to you. The street keeps ${tax}%.</p>
             <div class="bz-price">Ask <input type="number" id="bz-deed-price" min="1" max="${view?.maxDeedPrice ?? 5000}" value="${st.suggestedAsk ?? view?.licencePrice ?? 150}" /> <button type="button" id="bz-deed-list">Put the deed up for sale</button></div>`
      }`;
  }

  /** Another player's deed on the market. */
  function buyDeedHtml(ask: number) {
    const me = d.me();
    const why = mine() ? "You already have a stall. Sell yours first." : (me?.coins ?? 0) < ask ? `You need ${ask} coins.` : "";
    return `<h4>📜 Deed for sale</h4>
      <p class="bz-note">The owner is selling this stall's deed, an NFT on NEAR. Buy it and the stall is yours: no street cred needed.</p>
      <button type="button" id="bz-deed-buy" ${why ? "disabled" : ""}>Buy the deed · ${ask} coins</button>
      ${why ? `<p class="bz-note">${why}</p>` : ""}`;
  }

  function openPanel(s: Slot) {
    open = s;
    d.cm.resetInput();
    $("bz-own-prompt").hidden = true;
    $("bz-own").hidden = false;
    renderPanel(s);
  }
  function close() {
    open = null;
    $("bz-own").hidden = true;
  }

  // ---------- walking up ----------
  let near: Slot | null = null;
  addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    if (e.code === "KeyF" && near && !open && !d.busy()) {
      e.preventDefault();
      openPanel(near);
    }
    if (e.code === "Escape" && open) close();
  });
  const v = new THREE.Vector3();
  d.frame.add(() => {
    const cam = d.camera();
    const p = d.cm.getActiveEntity().position;
    let best: Slot | null = null;
    for (const s of slots) {
      const dist = p.distanceTo(s.pos);
      v.copy(s.pos).setY(s.pos.y + 3.1).project(cam);
      const show = v.z < 1 && dist < 70 && !open && !d.busy();
      s.tag.style.display = show ? "" : "none";
      if (show) s.tag.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
      if (d.cm.activeMode === "person" && Math.hypot(p.x - s.front.x, p.z - s.front.z) < REACH) best = s;
    }
    if (best !== near) {
      near = best;
      $("bz-own-prompt").hidden = !near || !!open || d.busy();
      if (near) {
        const sv = view?.slots.find((x) => x.slot === near!.slot);
        $("bz-own-prompt-text").textContent = !sv?.owner ? "Look at this stall for licence" : sv.mine ? "Run your stall" : `Browse ${sv.owner}'s stall${sv.ask ? " (deed for sale)" : ""}`;
      }
    }
  });

  /** Stand at a slot's counter (also used by the HUD's travel helpers). */
  function goToSlot(i: number) {
    const s = slots[i];
    if (!s) return;
    const to = new THREE.Vector3().subVectors(s.pos, s.front).setY(0).normalize();
    d.cm.teleportActiveTo(s.front.x - to.x * 0.6, s.front.z - to.z * 0.6, Math.atan2(to.x, to.z));
  }
  const w = window as unknown as { __bazaarCity?: Record<string, unknown> };
  if (w.__bazaarCity) w.__bazaarCity.goToSlot = goToSlot;

  return { refresh, goToSlot };
}
