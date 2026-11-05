import "./style.css";
import { Bazaar, type StallLook } from "./scene";
import { api, type Check, type Ending, type MerchantInfo, type Opened, type Tell, type TurnOut } from "./api";

// ---------- looks (original designs, one per merchant) ----------

const LOOKS: Record<string, StallLook> = {
  farrukh: { id: "farrukh", cloth: "#8c2f39", cloth2: "#e8c07a", robe: "#4a5d7a", skin: "#b07a55", hat: "wrap", good: "rug" },
  zaria: { id: "zaria", cloth: "#c4523b", cloth2: "#f0b448", robe: "#6a2c4a", skin: "#8a5a3c", hat: "hood", good: "saffron" },
  tobin: { id: "tobin", cloth: "#2e6e6a", cloth2: "#e9d9b0", robe: "#7a5a2e", skin: "#d9a982", hat: "cap", good: "lamp" },
};
const GOOD_ICON: Record<string, string> = { rug: "🧶", saffron: "🌶️", lamp: "🪔" };
const TELL_TEXT: Record<Tell, string> = { relaxed: "At ease", firm: "Arms folded", nervous: "Fidgeting", irritated: "Losing patience" };
const NEED_TEXT: Record<string, string> = {
  rent_due: "Rent due tonight",
  restocking: "Cash to restock",
  comfortable: "In no hurry",
  hoarding: "Loved this piece",
};

// ---------- tiny DOM helpers ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** *stage directions* in italics; everything else escaped. */
const speech = (s: string) => esc(s).replace(/\*([^*]+)\*/g, '<em class="stage">$1</em>');
const short = (h: string, n = 8) => `${h.slice(0, n)}…${h.slice(-4)}`;
const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: fine, just not remembered */
    }
  },
};

function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((toast as unknown as { h: number }).h);
  (toast as unknown as { h: number }).h = window.setTimeout(() => (t.hidden = true), 4500);
}

// ---------- player ----------

function playerId() {
  let id = store.get("bazaar.player");
  if (!id || !/^guest-[0-9a-f]{8,16}$/.test(id)) {
    const b = crypto.getRandomValues(new Uint8Array(6));
    id = `guest-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
    store.set("bazaar.player", id);
  }
  return id;
}
const PLAYER = playerId();

async function refreshPurse(bump = false) {
  try {
    const p = await api.player(PLAYER);
    $("coins").textContent = String(p.coins);
    $("goods").innerHTML = Object.entries(p.goods)
      .filter(([, n]) => n > 0)
      .map(([g, n]) => `<span title="${esc(g)}">${GOOD_ICON[g] ?? "•"} ${n}</span>`)
      .join("");
    $("purse").title = p.onchain ? `Read from ${p.contractId} (${p.network}) · ${p.id}` : "Offchain demo balance";
    if (bump) {
      $("purse").classList.remove("bump");
      void $("purse").offsetWidth;
      $("purse").classList.add("bump");
    }
  } catch {
    /* the purse can wait */
  }
}

// ---------- state ----------

let merchants: MerchantInfo[] = [];
let current: { m: MerchantInfo; opened: Opened | null; ending: Ending | null; busy: boolean } | null = null;

const canvas = $<HTMLCanvasElement>("scene");
let bazaar: Bazaar;

// ---------- labels ----------

function buildLabels() {
  const host = $("labels");
  host.innerHTML = "";
  for (const m of merchants) {
    const el = document.createElement("button");
    el.className = "label";
    el.type = "button";
    el.id = `label-${m.id}`;
    el.innerHTML = `<strong>${esc(m.name)}</strong><span>${esc(m.good.name)}</span>`;
    el.addEventListener("click", () => pick(m.id));
    el.addEventListener("mouseenter", () => el.classList.add("hot"));
    el.addEventListener("mouseleave", () => el.classList.remove("hot"));
    host.appendChild(el);
  }
}

// ---------- haggle panel ----------

const log = $("p-log");
const input = $<HTMLInputElement>("p-input");

function addMsg(who: "merchant" | "player", text: string, meta?: string) {
  const el = document.createElement("div");
  el.className = `msg ${who}`;
  el.innerHTML = (who === "merchant" ? speech(text) : esc(text)) + (meta ? `<span class="meta">${esc(meta)}</span>` : "");
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}
function addSys(html: string, cls = "") {
  const el = document.createElement("div");
  el.className = `sys ${cls}`;
  el.innerHTML = html;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}
function typing(on: boolean) {
  log.querySelector(".typing")?.remove();
  if (on) {
    const el = document.createElement("div");
    el.className = "typing";
    el.setAttribute("aria-label", "The merchant is thinking");
    el.innerHTML = "<i></i><i></i><i></i>";
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }
}
function setAsk(n: number | null) {
  const el = $("p-ask");
  const prev = Number(el.textContent);
  el.textContent = n === null ? "–" : String(n);
  if (n !== null && prev && n < prev) {
    el.classList.remove("drop");
    void el.offsetWidth;
    el.classList.add("drop");
  }
  $("q-take").textContent = n === null ? "Take it" : `Take it (${n})`;
}
function setTell(t: Tell) {
  $("p-tell").dataset.tell = t;
  $("p-tell-text").textContent = TELL_TEXT[t];
  if (current) bazaar.setTell(current.m.id, t);
}
function setEnabled(on: boolean) {
  input.disabled = !on;
  $<HTMLButtonElement>("p-send").disabled = !on;
  $<HTMLButtonElement>("q-take").disabled = !on;
  $<HTMLButtonElement>("q-leave").disabled = !on;
  if (on && matchMedia("(pointer: fine)").matches) input.focus();
}

function steps(items: { label: string; state: "todo" | "doing" | "done" | "fail" }[]) {
  $("p-steps").innerHTML = items.map((s) => `<li class="${s.state}"><span class="st"></span><span>${s.label}</span></li>`).join("");
}

async function pick(id: string) {
  if (current) return;
  const m = merchants.find((x) => x.id === id);
  if (!m) return;
  current = { m, opened: null, ending: null, busy: true };
  document.body.classList.add("focused");
  bazaar.focus(id);
  bazaar.setTell(id, "relaxed");

  $("p-name").textContent = m.name;
  $("p-good").textContent = m.good.name;
  $("p-seal").innerHTML = "";
  log.innerHTML = "";
  setAsk(null);
  setTell("relaxed");
  setEnabled(false);
  $("panel").hidden = false;

  const s = [
    { label: "Verifying the merchant's AI enclave <span class='mono'>(Intel TDX + NVIDIA)</span>", state: "doing" as const },
    { label: "Sealing the merchant's secret on NEAR", state: "todo" as const },
  ];
  steps(s);
  // The server does both in one call; advance the second step when the first is plausibly done.
  const t = setTimeout(() => steps([{ ...s[0], state: "done" }, { ...s[1], state: "doing" }]), 4500);
  try {
    const opened = await api.open(id, PLAYER);
    clearTimeout(t);
    if (!current || current.m.id !== id) return;
    current.opened = opened;
    steps([
      { ...s[0], state: "done" },
      { ...s[1], state: "done" },
    ]);
    setTimeout(() => ($("p-steps").innerHTML = ""), 1400);
    renderSeal();
    setAsk(opened.openingAsk);
    addMsg("merchant", `*spreads the ${m.good.name.toLowerCase().replace(/ \(.*\)/, "")} across the counter* For you, friend, ${opened.openingAsk} coins.`);
    bazaar.talk(id);
    addSys(`You have <b>${opened.budget}</b> coins. Make an offer, or talk them down.`);
    current.busy = false;
    setEnabled(true);
    void refreshPurse();
  } catch (e) {
    clearTimeout(t);
    steps([{ ...s[0], state: "fail" }, s[1]]);
    addSys(esc((e as Error).message), "bad");
    addSys(`<button class="chip" id="retry" type="button">Back to the bazaar</button>`);
    $("retry").addEventListener("click", leaveStall);
  }
}

function renderSeal() {
  const o = current?.opened;
  if (!o) return;
  const sealed = o.openTxUrl
    ? `<a href="${esc(o.openTxUrl)}" target="_blank" rel="noopener">🔒 Secret sealed on NEAR</a> <span class="mono">${short(o.commitment)}</span>`
    : `🔒 Secret committed <span class="mono">${short(o.commitment)}</span>`;
  const ok = o.attestation.checks.every((c) => c.ok);
  $("p-seal").innerHTML = `${sealed}<button type="button" id="seal-tee" class="${ok ? "ok" : ""}">${ok ? "✓" : "✗"} TEE verified</button>`;
  $("seal-tee").addEventListener("click", openVerify);
}

async function say(text: string) {
  if (!current?.opened || current.busy || current.ending) return;
  const { m, opened } = current;
  current.busy = true;
  setEnabled(false);
  addMsg("player", text);
  typing(true);
  let r: TurnOut;
  try {
    r = await api.turn(opened.haggleId, text);
  } catch (e) {
    typing(false);
    addSys(esc((e as Error).message), "bad");
    current.busy = false;
    setEnabled(true);
    return;
  }
  typing(false);
  if (r.refused) {
    addSys(`You only have <b>${r.refused.budget}</b> coins. You can't offer ${r.refused.price}.`, "bad");
  } else {
    if (r.text) {
      addMsg("merchant", r.text);
      bazaar.talk(m.id, Math.min(3200, 900 + r.text.length * 25));
    }
    if (r.tell) setTell(r.tell);
    if (r.ask !== null) setAsk(r.ask);
    if (r.action === "final") addSys("That's their final price.");
    if (r.action === "accept") addSys(`🤝 Deal at <b>${r.price}</b> coins`, "deal");
    if (r.action === "walk") addSys(`${esc(m.name)} has had enough and turns away.`, "bad");
    if (r.action === "left") addSys("You walk away from the stall.");
  }
  if (r.end) {
    current.ending = r.end;
    addSys("Revealing the secret onchain…");
    setTimeout(() => showReveal(r.end!), 900);
    void refreshPurse(true);
    return;
  }
  current.busy = false;
  setEnabled(true);
}

function leaveStall() {
  $("panel").hidden = true;
  $("reveal").hidden = true;
  document.body.classList.remove("focused");
  if (current) bazaar.setTell(current.m.id, "relaxed");
  current = null;
  bazaar.overview();
}

// ---------- reveal ----------

function showReveal(e: Ending) {
  const m = current!.m;
  const card = $("r-card");
  card.classList.remove("flipped");
  $("reveal").hidden = false;

  const deal = e.status === "deal";
  $("r-title").textContent = deal ? `You bought the ${m.good.name}` : e.status === "walked" ? `${m.name} sent you away` : "You walked away";
  $("r-floor").textContent = `${e.secret.floor}`;
  $("r-need").textContent = NEED_TEXT[e.secret.need] ?? e.secret.need;
  $("r-paid-label").textContent = deal ? "You paid" : "Asked at first";
  $("r-paid").textContent = deal ? `${e.dealPrice}` : `${e.secret.listPrice}`;
  $("r-verdict").innerHTML = deal
    ? e.leftOnTable === 0
      ? "Perfect. You paid exactly the floor. Nobody haggles better."
      : `${esc(m.name)} would have gone down to <b>${e.secret.floor}</b>. You left <b>${e.leftOnTable}</b> coins on the table.`
    : `They'd have sold for <b>${e.secret.floor}</b>. Now you know.`;
  $("r-bluffs").innerHTML = e.bluffs
    .map((b) => `<li>Turn ${b.turn}: claimed nothing below <b>${b.claimed}</b>. The real floor was ${e.secret.floor}. <b>A bluff of ${b.claimed - e.secret.floor}.</b></li>`)
    .join("");

  const failed = e.checks.filter((c) => !c.ok).length;
  const badge = $("r-badge");
  badge.classList.toggle("bad", failed > 0);
  badge.textContent = failed ? `✗ ${failed} of ${e.checks.length} checks failed` : `✓ Fair play verified · ${e.checks.length} checks`;
  setTimeout(() => card.classList.add("flipped"), 650);
  setTimeout(() => $<HTMLButtonElement>("r-back").focus(), 1500);
}

function downloadProof() {
  const e = current?.ending;
  if (!e) return;
  const blob = new Blob([JSON.stringify(e.bundle, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bazaar-proof-${current!.opened!.haggleId.slice(0, 8)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- verify drawer ----------

const checkList = (cs: Check[]) =>
  `<ul class="checks">${cs.map((c) => `<li class="${c.ok ? "" : "no"}"><span>${esc(c.label)}${c.detail ? `<small>${esc(c.detail)}</small>` : ""}</span></li>`).join("")}</ul>`;

function openVerify() {
  const o = current?.opened;
  const e = current?.ending;
  if (!o) return;
  const chainChecks = e?.checks.filter((c) => c.id.startsWith("chain.")) ?? [];
  const replay = e?.checks.filter((c) => !c.id.startsWith("chain.")) ?? [];
  const link = (url: string | null | undefined, text: string) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : "–");
  $("v-body").innerHTML = `
    <section>
      <h3>1 · The AI runs in a verified enclave</h3>
      <p class="sub">Before the first word, we fetched the model's attestation with a fresh random nonce and checked it with Intel and NVIDIA.</p>
      <dl class="kv">
        <dt>Model</dt><dd class="mono">${esc(o.attestation.model)}</dd>
        <dt>Nonce</dt><dd class="mono">${esc(short(o.attestation.nonce, 16))}</dd>
        <dt>Signing key</dt><dd class="mono">${o.attestation.signers.map((s) => esc(s)).join("<br>")}</dd>
      </dl>
      <details><summary>${o.attestation.checks.length} attestation checks</summary>${checkList(o.attestation.checks)}</details>
    </section>
    <section>
      <h3>2 · The secret was sealed on NEAR first</h3>
      <p class="sub">The merchant's floor and need were hashed and posted to the contract before you spoke. When the haggle ended, the contract checked the reveal against that hash and the floor, and only then moved coins.</p>
      <dl class="kv">
        <dt>Commitment</dt><dd class="mono">${esc(o.commitment)}</dd>
        <dt>Sealed</dt><dd>${link(o.openTxUrl, o.openTx ? short(o.openTx) : "")}</dd>
        <dt>Revealed</dt><dd>${e ? link(e.chain?.closeTxUrl, e.chain?.closeTx ? short(e.chain.closeTx) : "") : "when the haggle ends"}</dd>
        ${e?.chain?.closeError ? `<dt>Error</dt><dd>${esc(e.chain.closeError)}</dd>` : ""}
      </dl>
      ${chainChecks.length ? checkList(chainChecks) : ""}
    </section>
    <section>
      <h3>3 · Every reply was replayed</h3>
      <p class="sub">${
        e
          ? "Each merchant line is checked: signed by the enclave's key, made for this haggle and the rules engine's decision, never shown the floor, and displayed exactly as signed."
          : "These checks run when the haggle ends."
      }</p>
      ${replay.length ? checkList(replay) : ""}
    </section>
    <section>
      <h3>Don't trust us. Check it yourself.</h3>
      <p class="sub">Download the proof and verify it with the open-source verifier. No API key needed.</p>
      ${e ? `<button class="btn" id="v-download" type="button">Download proof</button>` : ""}
      <pre class="cmd">git clone https://github.com/lopeselio/bazaar-of-liars
pnpm install && pnpm verify:haggle bazaar-proof.json</pre>
    </section>`;
  $("v-download")?.addEventListener("click", downloadProof);
  $("verify").hidden = false;
  $<HTMLButtonElement>("v-close").focus();
}

// ---------- wiring ----------

$("p-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const t = input.value.trim();
  if (!t) return;
  input.value = "";
  void say(t);
});
$("q-take").addEventListener("click", () => void say("take"));
$("q-leave").addEventListener("click", () => void say("leave"));
$("p-close").addEventListener("click", () => {
  if (current?.opened && !current.ending && !current.busy) void say("leave");
  else if (!current?.busy || !current?.opened) leaveStall();
});
$("r-back").addEventListener("click", leaveStall);
$("r-download").addEventListener("click", downloadProof);
$("r-badge").addEventListener("click", openVerify);
$("v-close").addEventListener("click", () => ($("verify").hidden = true));
$("how").addEventListener("click", () => ($("intro").hidden = false));
$("enter").addEventListener("click", () => {
  $("intro").hidden = true;
  store.set("bazaar.seenIntro", "1");
});
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("verify").hidden) $("verify").hidden = true;
  else if (!$("intro").hidden) $("intro").hidden = true;
});

// ---------- boot ----------

async function boot() {
  try {
    merchants = (await api.merchants()).merchants;
  } catch {
    toast("Can't reach the bazaar server. Is `pnpm dev` running?");
    return;
  }
  bazaar = new Bazaar(
    canvas,
    merchants.map((m) => LOOKS[m.id]).filter(Boolean),
  );
  buildLabels();
  if (import.meta.env.DEV) (window as unknown as { bazaar: Bazaar }).bazaar = bazaar; // dev-only: drive the camera from the console
  bazaar.onPick = pick;
  bazaar.onHover = (id) => {
    for (const m of merchants) $(`label-${m.id}`)?.classList.toggle("hot", m.id === id);
  };
  bazaar.onLabels = (pos) => {
    for (const [id, p] of Object.entries(pos)) {
      const el = $(`label-${id}`);
      if (!el) continue;
      el.style.display = p ? "" : "none";
      if (p) el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
    }
  };
  if (!store.get("bazaar.seenIntro")) $("intro").hidden = false;
  void refreshPurse();
}
void boot();
