/**
 * Dock work at Pier 34, the broke player's way back in.
 *
 * When the purse is nearly empty, a banner points to the docks at the west end of Canal Street.
 * There the player can work one shift a day for Auntie Wu, the wholesaler, who pays from her own
 * purse (she signs for it; the contract checks the player is broke and hasn't worked today).
 */
import * as THREE from "three";
import { api, type PlayerView } from "../../web/src/api";

/** Mirrors packages/core wages.ts. */
const DOCK = { x: -744, z: 3926 };
const DOCK_WAGE = 40;
const BROKE_BELOW = 20;
const REACH = 40;

export interface DocksDeps {
  scene: THREE.Scene;
  camera: () => THREE.Camera;
  player: string;
  cm: { activeMode: string; getActiveEntity(): { position: THREE.Vector3 }; getGroundHeight(x: number, z: number, mode?: string): number };
  frame: Set<(dt: number, t: number) => void>;
  me: () => PlayerView | null;
  refreshPurse: (bump?: boolean) => Promise<unknown>;
  toast: (msg: string) => void;
  burst: (n: number) => void;
  busy: () => boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function initDocks(d: DocksDeps) {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="bz-broke" hidden><i id="bz-broke-arrow">➤</i><div><b>Broke? Auntie Wu needs hands at Pier 34</b><span id="bz-broke-sub"></span></div></div>
     <div id="bz-dock-prompt" hidden><kbd>F</kbd><span>Unload crates for Auntie Wu (+${DOCK_WAGE} coins)</span></div>`,
  );
  const y = d.cm.getGroundHeight(DOCK.x, DOCK.z, "person");
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(2.2, 2.2, 120, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: "#6ee7a0", transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  );
  beam.position.set(DOCK.x, y + 60, DOCK.z);
  beam.visible = false;
  d.scene.add(beam);
  beam.updateMatrixWorld(true);

  let working = false;
  let worked = false; // this session; the contract has the real once-a-day rule
  const broke = () => {
    const m = d.me();
    return !!m && m.coins < BROKE_BELOW && !worked;
  };
  async function work() {
    if (working) return;
    working = true;
    const p = d.cm.getActiveEntity().position;
    try {
      const r = await api.dockWork(d.player, p.x, p.z);
      worked = true;
      d.toast(`A shift's work: Auntie Wu paid you ${r.wage} coins. Back to Canal Street to trade.`);
      d.burst(r.wage);
      await d.refreshPurse(true);
    } catch (e) {
      d.toast((e as Error).message);
      if (/already worked/.test((e as Error).message)) worked = true;
    } finally {
      working = false;
    }
  }
  let atDock = false;
  addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT" || d.busy()) return;
    if (e.code === "KeyF" && atDock) {
      e.preventDefault();
      void work();
    }
  });

  const dir = new THREE.Vector3();
  let last = 0;
  d.frame.add((_dt, t) => {
    if (t - last < 0.2) return;
    last = t;
    const show = broke();
    beam.visible = show;
    $("bz-broke").hidden = !show;
    const p = d.cm.getActiveEntity().position;
    const dist = Math.hypot(DOCK.x - p.x, DOCK.z - p.z);
    atDock = show && dist < REACH && !d.busy();
    $("bz-dock-prompt").hidden = !atDock;
    if (!show) return;
    d.camera().getWorldDirection(dir);
    const rel = Math.atan2(DOCK.x - p.x, DOCK.z - p.z) - Math.atan2(dir.x, dir.z);
    $("bz-broke-arrow").style.transform = `rotate(${-rel - Math.PI / 2}rad)`;
    $("bz-broke-sub").textContent = dist < REACH ? "You're at the docks. Press F to work a shift." : `West end of Canal Street · ${dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`} · one shift a day pays ${DOCK_WAGE}`;
  });
}
