/**
 * "Where to?": every place worth walking to, with "Guide me" to set the waypoint there.
 *
 * A button in the HUD's row (and in Help) opens the list: the merchants' stalls on Canal Street,
 * Pier 34 and Auntie Wu, the informants, the stall licences and the drop sites of the jobs
 * posted right now. Distances are from where you stand when it opens.
 */
import * as THREE from "three";
import { metres, type Target } from "./waypoint";

export interface Place extends Target {
  icon: string;
  note: string;
}
export interface PlaceGroup {
  title: string;
  places: Place[];
}

export interface WhereToDeps {
  cm: { getActiveEntity(): { position: THREE.Vector3 } };
  groups: () => PlaceGroup[];
  guide: (t: Target) => void;
  /** True while a haggle panel is open (the keys belong to it). */
  busy: () => boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function initWhereTo(d: WhereToDeps) {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<button id="bz-where-btn" class="bz-card" type="button" title="Where to? Places to go, with directions">🧭 <span>Where to?</span></button>
     <section id="bz-where" class="bz-card" hidden aria-label="Where to?">
       <header><div><b>Where to?</b><span>Pick a place and follow the pillar of light.</span></div><button id="bz-where-x" type="button" aria-label="Close">✕</button></header>
       <div id="bz-where-list"></div>
     </section>`,
  );
  (document.querySelector("#bz-actions") ?? document.querySelector("#bz-hud"))?.appendChild($("bz-where-btn"));

  let shown: Place[] = [];
  function render() {
    const p = d.cm.getActiveEntity().position;
    shown = [];
    $("bz-where-list").innerHTML = d
      .groups()
      .filter((g) => g.places.length)
      .map(
        (g) =>
          `<h4>${esc(g.title)}</h4><ol>${g.places
            .map((pl) => {
              const i = shown.push(pl) - 1;
              return `<li><i aria-hidden="true">${pl.icon}</i><div><b>${esc(pl.name)}</b><span>${esc(pl.note)} · ${metres(Math.hypot(pl.x - p.x, pl.z - p.z))}</span></div><button type="button" data-go="${i}">Guide me</button></li>`;
            })
            .join("")}</ol>`,
      )
      .join("");
  }
  const toggle = (open = $("bz-where").hidden) => {
    $("bz-where").hidden = !open;
    if (open) render();
  };
  $("bz-where-btn").addEventListener("mousedown", (e) => e.preventDefault()); // keep Space for the city
  $("bz-where-btn").addEventListener("click", () => toggle());
  $("bz-where-x").addEventListener("click", () => toggle(false));
  $("bz-where-list").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-go]");
    const pl = b && shown[Number(b.dataset.go)];
    if (!pl) return;
    d.guide({ id: pl.id, name: pl.name, x: pl.x, z: pl.z });
    toggle(false);
  });
  addEventListener("keydown", (e) => {
    if (e.code === "Escape" && !$("bz-where").hidden && !d.busy()) toggle(false);
  });
  addEventListener("bz:whereto", () => toggle(true));
}
