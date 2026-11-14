/**
 * "Where to next?": the starter quests and the objective banner.
 *
 * One objective at a time, in a compact banner at the top (the job tracker's look) with the
 * distance and an arrow, and a waypoint at the spot (waypoint.ts). Each step completes from what
 * the player actually does: walking there, a deal or a bluff call (bz:signal), the wire opening,
 * a delivery settling. The chain is remembered in localStorage, can be skipped a step at a time or
 * hidden, and comes back from Help. The same banner also carries "Where to?" guidance and, for a
 * returning player who spawned far away, "Head back to Canal Street".
 */
import * as THREE from "three";
import { onSignal, type Signal } from "./signals";
import { metres, type Target, type Waypoint } from "./waypoint";

export interface QuestDeps {
  way: Waypoint;
  camera: () => THREE.Camera;
  cm: { getActiveEntity(): { position: THREE.Vector3 } };
  frame: Set<(dt: number, t: number) => void>;
  burst: (n: number) => void;
  /** True while the player stands among the stalls on Canal Street. */
  onCanal: () => boolean;
  /** Metres to the stalls on Canal Street. */
  canalDistance: () => number;
  canal: () => Target | null;
  farrukh: () => Target | null;
  informant: (id: string) => Target | null;
  pier: Target;
  goToCanal: () => void;
  /** A delivery job is on (its own tracker and beacons lead the way). */
  hasJob: () => boolean;
  signedIn: boolean;
  /** First time in the city (this browser had never arrived on Canal Street before). */
  firstVisit: boolean;
}

interface Step {
  id: string;
  optional?: boolean;
  /** Bits of the banner, worked out each time it's drawn. */
  title: () => string;
  sub: () => string;
  target?: () => Target | null;
  /** Done when this is true... */
  check?: () => boolean;
  /** ...or when one of these happens. */
  signals?: Signal[];
  /** Name for the toast when it's done. */
  doneText: string;
  /** Extra buttons: [action id, label]. */
  actions?: () => [string, string][];
  /** The banner steps aside while this is true (another guide is leading). */
  aside?: () => boolean;
  /** Already covered by something done later in the chain: passed over quietly. */
  covered?: () => boolean;
}

type Status = "on" | "off" | "done";
interface State {
  v: 1;
  status: Status;
  done: string[];
}

const KEY = "bazaar.city.quests";
const FAR = 400; // further than this from the stalls, offer the ride back
const ARRIVE = 8;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const touch = () => document.body.classList.contains("touch-enabled") || matchMedia("(any-pointer: coarse)").matches;
/** The top banners already on screen, in the order they sit; the objective goes under them. */
const ABOVE = ["bz-track", "bz-event", "bz-broke", "bz-ship", "bz-guide"];

function load(): State | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as State | null;
    return s && s.v === 1 && Array.isArray(s.done) ? s : null;
  } catch {
    return null;
  }
}
function save(s: State) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* not remembered: the quests start over next time */
  }
}

/** For the help sheet: whether the starter quests are running, hidden or finished. */
export function questStatus(): Status | "new" {
  return load()?.status ?? "new";
}

export function initQuests(d: QuestDeps) {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="bz-quest" hidden role="status" aria-live="polite">
       <i id="bz-quest-arrow" aria-hidden="true">➤</i>
       <div class="bz-quest-text"><b id="bz-quest-title"></b><span id="bz-quest-sub"></span></div>
       <span id="bz-quest-btns"></span>
     </div>
     <div id="bz-quest-toast" hidden role="status" aria-live="polite"></div>`,
  );

  const t = touch();
  const wireOpen = () => !$("bz-wire").hidden && $("bz-wire").classList.contains("open");
  const shipIn = () => !$("bz-ship").hidden;
  const steps: Step[] = [
    {
      id: "canal",
      title: () => "Go to Canal Street",
      sub: () => (d.canalDistance() > FAR ? `The stalls in Chinatown · ${metres(d.canalDistance())} · or ride there now` : `The stalls in Chinatown · ${metres(d.canalDistance())}`),
      target: d.canal,
      check: d.onCanal,
      doneText: "You're on Canal Street",
      actions: () => (d.canalDistance() > FAR ? [["canal", "→ Canal St"]] : []),
    },
    {
      id: "farrukh",
      title: () => "Walk to Farrukh's stall",
      sub: () => "Farrukh sells silk rugs. Follow the pillar of light.",
      target: d.farrukh,
      check: () => {
        const f = d.farrukh();
        if (!f) return false;
        const p = d.cm.getActiveEntity().position;
        return Math.hypot(f.x - p.x, f.z - p.z) < 6;
      },
      doneText: "You found Farrukh",
      covered: () => state.done.includes("haggle"),
      actions: () => (d.canalDistance() > FAR ? [["canal", "→ Canal St"]] : []),
    },
    {
      id: "haggle",
      title: () => (t ? "Tap Haggle, then make a deal" : "Press F and haggle"),
      sub: () => "Buy something, or call a bluff when they swear a price. Any stall counts.",
      target: d.farrukh,
      signals: ["haggled", "bluff"],
      doneText: "Your first haggle",
      actions: () => (d.canalDistance() > FAR ? [["canal", "→ Canal St"]] : []),
    },
    {
      id: "wire",
      title: () => "Open the Canal St wire",
      sub: () => ($("bz-wire").hidden ? "It shows up at the bottom of your HUD once the agents are trading." : "Bottom of your HUD: what the AI agents are trading onchain, right now."),
      check: wireOpen,
      doneText: "You're reading the wire",
      actions: () => ($("bz-wire").hidden ? [] : [["wire", "Open it"]]),
    },
    {
      id: "job",
      title: () => (t ? "Tap Jobs and take a delivery" : "Press J and take a delivery job"),
      sub: () => "Buy the good on Canal Street, carry it to the customer's door, collect the bounty.",
      signals: ["delivered"],
      doneText: "Your first delivery",
      actions: () => [["jobs", "📋 Jobs"]],
      // Once a job is taken, its own tracker bar and beacons take over until it's delivered.
      aside: d.hasJob,
    },
    {
      id: "signin",
      optional: true,
      title: () => "Optional: sign in with NEAR",
      sub: () => "Keep your coins, goods and cred in your own testnet account. One signed message, no gas.",
      check: () => d.signedIn,
      doneText: "Signed in",
      actions: () => [["signin", "🔑 Sign in"]],
    },
    {
      id: "extra",
      optional: true,
      title: () => (shipIn() ? "Optional: a cargo ship is in at Pier 34" : "Optional: buy a tip from Madame Vex"),
      sub: () =>
        shipIn()
          ? `Stand in the gold beam and ${t ? "tap the prompt" : "press G"} to bid, sealed onchain. Or buy a tip from Madame Vex, or follow a 📈 trade route.`
          : `She's tagged 🕵️ just west of the stalls; lies are refunded. Or bid at Pier 34 when a ship docks, or follow the 📈 chip.`,
      target: () => (shipIn() ? d.pier : d.informant("vex")),
      signals: ["tip", "bid", "route-trade"],
      doneText: "You've seen the street's secrets",
    },
  ];

  const stored = load();
  // Players who were here before the quests existed get them in Help, not in their face.
  let state: State = stored ?? { v: 1, status: d.firstVisit ? "on" : "off", done: [] };
  if (!stored) {
    save(state);
    if (!d.firstVisit) setTimeout(() => showToast("New: starter quests and 🧭 Where to?", "Find the quests in ? Help, any time."), 6000);
  }
  if (d.signedIn && !state.done.includes("signin")) {
    state.done.push("signin");
    save(state);
  }
  const current = () => (state.status === "on" ? steps.find((s) => !state.done.includes(s.id)) ?? null : null);

  /** "Where to?" guidance: wins over the quest step until you arrive or stop it. */
  let manual: Target | null = null;
  /** A returning player far from the stalls: "Head back to Canal Street", until there or dismissed. */
  let headBack = !d.firstVisit && !d.onCanal();

  // ---------- the celebratory toast ----------
  let toastTimer = 0;
  function showToast(title: string, sub = "") {
    const el = $("bz-quest-toast");
    el.innerHTML = `<b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ""}`;
    el.hidden = false;
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (el.hidden = true), 4200);
  }

  function complete(id: string, quiet = false) {
    if (state.done.includes(id)) return;
    const step = steps.find((s) => s.id === id);
    state.done.push(id);
    const next = current();
    if (!next && state.status === "on") {
      state.status = "done";
      save(state);
      d.way.set(manual);
      showToast("🏮 Starter quests complete!", "You know your way around Canal Street. 🧭 Where to? lists every place.");
      d.burst(30);
      return;
    }
    save(state);
    if (!quiet && step) {
      showToast(`✓ ${step.doneText}`, next ? `Next: ${next.title()}` : "");
      d.burst(8);
    }
  }

  onSignal((kind) => {
    if (state.status !== "on") return;
    for (const s of steps) if (s.signals?.includes(kind)) complete(s.id);
  });

  // ---------- controls ----------
  let lastKey = ""; // the banner's buttons, redrawn only when they change
  function stopQuests() {
    state.status = "off";
    save(state);
    d.way.set(manual);
    showToast("Starter quests hidden", "Bring them back any time from ? Help.");
  }
  $("bz-quest-btns").addEventListener("mousedown", (e) => e.preventDefault()); // keep Space for the city
  $("bz-quest-btns").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    const step = current();
    if (act === "canal") d.goToCanal();
    else if (act === "wire") $("bz-wire-toggle").click();
    else if (act === "jobs") $("bz-jobs-btn").click();
    else if (act === "signin") dispatchEvent(new Event("bz:signin"));
    else if (act === "skip" && step) complete(step.id, true);
    else if (act === "hide") stopQuests();
    else if (act === "stop") {
      manual = null;
      d.way.set(null);
    } else if (act === "headback-x") headBack = false;
    lastKey = ""; // redraw the buttons
  });

  // The help sheet's "Starter quests" and "Where to?" buttons.
  addEventListener("bz:quests", (e) => {
    const how = (e as CustomEvent<string>).detail;
    if (how === "restart") state = { v: 1, status: "on", done: d.signedIn ? ["signin"] : [] };
    else state.status = "on";
    save(state);
    const s = current();
    if (s) showToast("🧭 Starter quests", s.title());
  });

  // ---------- each tick ----------
  const dir = new THREE.Vector3();
  let last = 0;
  function draw(o: { title: string; sub: string; target: Target | null; actions: [string, string][] }) {
    const el = $("bz-quest");
    el.hidden = false;
    $("bz-quest-title").textContent = o.title;
    $("bz-quest-sub").textContent = o.sub;
    const key = o.actions.map((a) => a.join(":")).join("|");
    if (key !== lastKey) {
      lastKey = key;
      $("bz-quest-btns").innerHTML = o.actions.map(([id, label]) => `<button type="button" data-act="${id}" class="${id === "skip" || id === "hide" || id.endsWith("-x") || id === "stop" ? "minor" : ""}">${esc(label)}</button>`).join("");
    }
    const arrow = $("bz-quest-arrow");
    arrow.style.visibility = o.target ? "visible" : "hidden";
    if (o.target) {
      const p = d.cm.getActiveEntity().position;
      d.camera().getWorldDirection(dir);
      const rel = Math.atan2(o.target.x - p.x, o.target.z - p.z) - Math.atan2(dir.x, dir.z);
      arrow.style.transform = `rotate(${-rel - Math.PI / 2}rad)`;
    }
    // Sit under whichever top banners are showing.
    let top = 14;
    for (const id of ABOVE) {
      const b = document.getElementById(id);
      if (b && !b.hidden && getComputedStyle(b).display !== "none") top = Math.max(top, Math.round(b.getBoundingClientRect().bottom + 6));
    }
    el.style.top = `${top}px`;
  }
  const hide = () => {
    $("bz-quest").hidden = true;
  };

  const start = performance.now();
  d.frame.add((_dt, now) => {
    if (now - last < 0.15) return;
    last = now;
    // Let the loading screen fade and the welcome mount before the first objective (or toast).
    if (performance.now() - start < 2000) return;
    // The welcome, help sheet and walkthrough come first.
    if (document.querySelector(".ob-backdrop, .ob-tour")) return hide();

    if (manual) {
      const m = d.way.distance();
      if (m < ARRIVE) {
        showToast(`📍 You've arrived: ${manual.name}`);
        manual = null;
        d.way.set(null);
      } else {
        d.way.set(manual);
        return draw({ title: `🧭 ${manual.name}`, sub: `${metres(m)}${m > 1500 ? " · quicker to drive or cycle" : ""}`, target: manual, actions: [["stop", "Stop"]] });
      }
    }

    const step = current();
    if (step) {
      if (step.covered?.()) return complete(step.id, true);
      if (step.check?.()) return complete(step.id);
      if (step.aside?.()) {
        d.way.set(null);
        return hide();
      }
      const tg = step.target?.() ?? null;
      d.way.set(tg);
      const n = steps.indexOf(step) + 1;
      const dist = tg ? ` · ${metres(d.way.distance())}` : "";
      const actions: [string, string][] = [...(step.actions?.() ?? []), ["skip", step.optional ? "Later" : "Skip"], ["hide", "✕"]];
      return draw({ title: `${n}/${steps.length} · ${step.title()}`, sub: `${step.sub()}${step.id === "canal" ? "" : dist}`, target: tg, actions });
    }

    if (headBack) {
      if (d.onCanal()) headBack = false;
      else {
        const tg = d.canal();
        d.way.set(tg);
        return draw({ title: "Head back to Canal Street", sub: `The stalls in Chinatown · ${metres(d.canalDistance())}`, target: tg, actions: [["canal", "→ Canal St"], ["headback-x", "✕"]] });
      }
    }
    d.way.set(null);
    hide();
  });

  return {
    /** "Guide me" from Where to?: point the way there until the player arrives or stops it. */
    guide(t: Target) {
      manual = t;
      headBack = false;
      d.way.set(t);
    },
  };
}
