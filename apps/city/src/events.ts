/**
 * Street events: a festival, a shortage of one good, or an inspector raid on Canal Street. The
 * contract rolls which, every twelve minutes or so; prices and the agents react.
 *
 * A banner says what's on and how long it lasts. During a raid it warns a player who's carrying
 * more than the limit without a stall licence, before they walk into the inspectors.
 */
import { api, type PlayerView, type StreetEventView } from "../../web/src/api";

export interface EventDeps {
  player: string;
  me: () => PlayerView | null;
  hasLicence: () => boolean;
  toast: (msg: string) => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function initEvents(d: EventDeps) {
  document.body.insertAdjacentHTML("beforeend", `<div id="bz-event" hidden><b id="bz-event-title"></b><span id="bz-event-sub"></span></div>`);
  let view: StreetEventView | null = null;
  let announced = "";

  async function refresh() {
    try {
      view = await api.event(d.player);
    } catch {
      return;
    }
    const e = view.event;
    if (view.active && e && e.id !== announced) {
      if (announced) d.toast(view.headline ?? "Something's happening on the street.");
      announced = e.id;
    }
    if (!announced) announced = e?.id ?? "none";
    render();
  }

  /**
   * On a narrow screen the banner (centred at the top) wraps onto several lines over the HUD
   * column's player card. Push the column down by just the overlap; nothing moves on a wide screen.
   */
  function makeRoom() {
    const hud = document.getElementById("bz-hud");
    if (!hud) return;
    const el = $("bz-event");
    hud.style.removeProperty("--bz-event-push");
    if (el.hidden || hud.hidden) return;
    const b = el.getBoundingClientRect();
    const h = hud.getBoundingClientRect();
    const push = b.left < h.right && b.right > h.left ? Math.ceil(b.bottom + 8 - h.top) : 0;
    if (push > 0) hud.style.setProperty("--bz-event-push", `${push}px`);
  }
  addEventListener("resize", makeRoom);

  function render() {
    const el = $("bz-event");
    const e = view?.event;
    const on = !!view?.active && !!e && Date.now() < e.end_ms;
    el.hidden = !on;
    if (!on || !e || !view) return makeRoom();
    el.className = `bz-ev-${e.kind}`;
    $("bz-event-title").textContent = view.headline ?? "";
    let sub = `${clock(e.end_ms - Date.now())} left`;
    if (e.kind === "raid") {
      const goods = d.me()?.goods ?? {};
      const over = Object.values(goods).reduce((s, n) => s + Math.max(0, n - view!.raidLimit), 0);
      if (view.seized) sub += ` · they took ${view.seized} of your goods`;
      else if (over > 0 && !d.hasLicence()) sub += ` · ⚠ you're carrying ${over} too many: sell down or stay off Canal Street`;
      else sub += d.hasLicence() ? " · your stall licence covers you" : " · you're within the limit";
    }
    $("bz-event-sub").textContent = sub;
    makeRoom();
  }

  void refresh();
  setInterval(() => void refresh(), 6000);
  setInterval(render, 1000);
}
