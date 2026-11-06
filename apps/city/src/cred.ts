/**
 * Street cred in the HUD: level, title, XP bar and daily streak (all read from the contract),
 * with "+XP" popups when it grows and a celebration on level-up.
 */
import type { Cred } from "../../web/src/api";

/** Mirrors packages/core cred.ts UNLOCKS. */
const UNLOCKS: { level: number; what: string }[] = [
  { level: 2, what: "Express delivery jobs: bigger bounties, tighter clocks" },
  { level: 3, what: "Jobs from the far side of town: Times Square, Central Park" },
  { level: 5, what: "A stall licence on Canal Street (coming next)" },
];
const XP_RULES = [
  ["Close a deal", "+5"],
  ["Deliver a job", "+10, express +15"],
  ["Catch a merchant bluffing", "+4"],
  ["First XP of the day", "+5 × your streak (up to 7 days)"],
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function initCred(hud: HTMLElement) {
  hud.insertAdjacentHTML(
    "beforeend",
    `<button id="bz-cred" class="bz-card" type="button" title="Street cred" hidden>
       <span class="bz-lvl" id="bz-lvl">1</span>
       <span class="bz-cred-main"><b id="bz-title">Newcomer</b><span class="bz-bar"><i id="bz-bar"></i></span><small id="bz-xp"></small></span>
       <span class="bz-flame" id="bz-flame" hidden></span>
     </button>`,
  );
  document.body.insertAdjacentHTML(
    "beforeend",
    `<section id="bz-cred-panel" class="bz-card" hidden></section>
     <div id="bz-xp-pop"></div>
     <div id="bz-levelup" hidden></div>`,
  );
  let last: Cred | null = null;
  let firstRender = true;

  function panel(c: Cred) {
    $("bz-cred-panel").innerHTML = `
      <header><div><b>Street cred · level ${c.level}</b><span>${c.title} · ${c.xp} XP, kept onchain</span></div><button type="button" id="bz-cred-x" aria-label="Close">✕</button></header>
      <p class="bz-streak">${c.streak ? `🔥 ${c.streak}-day streak${c.activeToday ? " · today's bonus banked" : " · earn any XP today to keep it"}` : "Earn XP today to start a streak"} · best ${c.bestStreak}</p>
      <h4>How to earn it</h4>
      <ul>${XP_RULES.map(([a, b]) => `<li><span>${a}</span><b>${b}</b></li>`).join("")}</ul>
      <h4>What it unlocks</h4>
      <ul>${UNLOCKS.map((u) => `<li class="${c.level >= u.level ? "got" : ""}"><span>${c.level >= u.level ? "✓" : "🔒"} Level ${u.level}</span><b>${u.what}</b></li>`).join("")}</ul>`;
    $("bz-cred-x").addEventListener("click", () => ($("bz-cred-panel").hidden = true));
  }
  $("bz-cred").addEventListener("click", () => {
    $("bz-cred-panel").hidden = !$("bz-cred-panel").hidden;
  });

  function pop(text: string) {
    const el = document.createElement("div");
    el.className = "bz-xp-float";
    el.textContent = text;
    $("bz-xp-pop").appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  function levelUp(c: Cred) {
    const opened = UNLOCKS.filter((u) => u.level === c.level);
    $("bz-levelup").innerHTML = `
      <div class="bz-rv bz-lu">
        <p class="eyebrow">Street cred</p>
        <h3>Level ${c.level}: <b>${c.title}</b></h3>
        ${opened.length ? `<p>Unlocked: ${opened.map((u) => u.what).join("; ")}</p>` : `<p>Canal Street knows your name a little better.</p>`}
        <button type="button" id="bz-lu-ok">Back to the streets</button>
      </div>`;
    $("bz-levelup").hidden = false;
    $("bz-lu-ok").addEventListener("click", () => ($("bz-levelup").hidden = true));
  }

  /** Call whenever the player view is refreshed. */
  return function render(c: Cred | null) {
    if (!c) return;
    $("bz-cred").hidden = false;
    $("bz-lvl").textContent = String(c.level);
    $("bz-title").textContent = c.title;
    const span = Math.max(1, c.nextXp - c.levelXp);
    $("bz-bar").style.width = `${Math.min(100, ((c.xp - c.levelXp) / span) * 100)}%`;
    $("bz-xp").textContent = `${c.xp} / ${c.nextXp} XP`;
    $("bz-flame").hidden = c.streak === 0;
    $("bz-flame").textContent = `🔥${c.streak}`;
    $("bz-flame").title = c.activeToday ? `${c.streak}-day streak` : `${c.streak}-day streak: earn XP today to keep it`;
    $("bz-flame").classList.toggle("cold", !c.activeToday);
    if (!firstRender && last && c.xp > last.xp) {
      pop(`+${c.xp - last.xp} XP`);
      if (c.level > last.level) levelUp(c);
    }
    if (!$("bz-cred-panel").hidden || firstRender) panel(c);
    last = c;
    firstRender = false;
  };
}
