/**
 * One waypoint at a time: where the starter quests or "Where to?" are sending you.
 *
 * It shows three ways: a soft pillar of light at the spot (the same open cylinder as the job and
 * Pier 34 beams, nothing heavier), a marker that sits over the spot when it's on screen and
 * clings to the screen's edge with an arrow and the distance when it isn't, and the city's own
 * minimap waypoint (the taxi-yellow pin and route). The pillar only pulses when motion is allowed.
 */
import * as THREE from "three";

export interface Target {
  /** Stable id, so re-setting the same place doesn't reset anything. */
  id: string;
  name: string;
  x: number;
  z: number;
}

export interface WaypointDeps {
  scene: THREE.Scene;
  camera: () => THREE.Camera;
  cm: { getActiveEntity(): { position: THREE.Vector3 }; getGroundHeight(x: number, z: number, mode?: string): number };
  frame: Set<(dt: number, t: number) => void>;
  /** The city's map system; setting its waypoint draws the pin and route on the minimap and the full map. */
  map?: { waypoint: { x: number; z: number; name: string } | null };
}

/** Closer than this, the pillar would only block the view of what you came for. */
const NEAR = 14;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
export const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

export function initWaypoint(d: WaypointDeps) {
  document.body.insertAdjacentHTML("beforeend", `<div id="bz-way" hidden><i id="bz-way-arrow" aria-hidden="true">➤</i><span><b id="bz-way-name"></b><em id="bz-way-dist"></em></span></div>`);
  const el = document.getElementById("bz-way")!;
  const arrow = document.getElementById("bz-way-arrow")!;
  const nameEl = document.getElementById("bz-way-name")!;
  const distEl = document.getElementById("bz-way-dist")!;

  const mat = new THREE.MeshBasicMaterial({ color: "#fff1c4", transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 160, 16, 1, true), mat);
  pillar.visible = false;
  pillar.frustumCulled = false;
  d.scene.add(pillar);

  let target: Target | null = null;
  let groundY = 0;

  function set(t: Target | null) {
    if (t && target && t.id === target.id && t.x === target.x && t.z === target.z) return;
    target = t;
    if (!t) {
      pillar.visible = false;
      el.hidden = true;
      return;
    }
    groundY = d.cm.getGroundHeight(t.x, t.z, "person");
    pillar.position.set(t.x, groundY + 80, t.z);
    pillar.scale.set(1, 1, 1);
    pillar.updateMatrixWorld(true); // the city doesn't auto-update matrices
    nameEl.textContent = t.name;
    if (d.map) d.map.waypoint = { x: t.x, z: t.z, name: t.name };
  }

  const distance = () => {
    if (!target) return Infinity;
    const p = d.cm.getActiveEntity().position;
    return Math.hypot(target.x - p.x, target.z - p.z);
  };

  const v = new THREE.Vector3();
  d.frame.add((_dt, t) => {
    if (!target) return;
    const m = distance();
    pillar.visible = m > NEAR;
    if (pillar.visible && !reduced.matches) {
      mat.opacity = 0.26 + 0.08 * Math.sin(t * 2.2);
    } else mat.opacity = 0.3;

    // Out of the way while a panel has the player's attention.
    if (document.body.classList.contains("bz-talking") || document.querySelector(".ob-backdrop")) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    distEl.textContent = metres(m);
    // A point a little above the spot, so the marker floats over a stall rather than inside it.
    v.set(target.x, groundY + (m < 60 ? 4 : 12), target.z).project(d.camera());
    const behind = v.z > 1;
    const x = behind ? -v.x : v.x;
    let y = behind ? -v.y : v.y;
    const onScreen = !behind && Math.abs(x) < 0.9 && Math.abs(y) < 0.86;
    el.classList.toggle("edge", !onScreen);
    const W = innerWidth;
    const H = innerHeight;
    if (onScreen) {
      arrow.style.transform = "rotate(90deg)";
      el.style.transform = `translate(${((x + 1) / 2) * W}px, ${((1 - y) / 2) * H}px) translate(-50%, -100%)`;
      return;
    }
    // Off screen (or behind you): push the point out along its direction until it meets the edge.
    // At the edge it's only the arrow and the distance (css), about 80 × 40 px; keep it clear of the edge.
    if (behind && Math.abs(x) < 0.05 && Math.abs(y) < 0.05) y = -1;
    const hx = W / 2 - 56;
    const hy = H / 2 - 40;
    const sx = (x * W) / 2;
    const sy = (-y * H) / 2;
    const k = 1 / Math.max(Math.abs(sx) / hx, Math.abs(sy) / hy, 1e-6);
    arrow.style.transform = `rotate(${Math.atan2(sy, sx)}rad)`;
    el.style.transform = `translate(${W / 2 + sx * k}px, ${H / 2 + sy * k}px) translate(-50%, -50%)`;
  });

  return { set, get: () => target, distance };
}

export type Waypoint = ReturnType<typeof initWaypoint>;
