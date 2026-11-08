import "./style.css";
import sampleUrl from "../../../examples/sample-haggle.json?url";
import { checkBundleHere } from "./selfcheck";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function run(text: string, name: string) {
  const out = $("out");
  out.hidden = false;
  $("badge").className = "badge";
  $("badge").textContent = `Checking ${name}…`;
  $("summary").textContent = "Reading the contract and transactions from NEAR testnet.";
  $("list").innerHTML = "";
  let bundle: unknown;
  try {
    bundle = JSON.parse(text);
  } catch {
    $("badge").className = "badge bad";
    $("badge").textContent = "That file isn't JSON";
    $("summary").textContent = "";
    return;
  }
  try {
    const r = await checkBundleHere(bundle);
    $("badge").className = `badge ${r.failed ? "bad" : "good"}`;
    $("badge").textContent = r.failed ? `✗ ${r.failed} of ${r.checks.length} checks failed` : `✓ Fair play verified · ${r.checks.length} checks`;
    const b = bundle as { merchant?: { name?: string }; chain?: { contractId?: string } };
    $("summary").textContent = `${b.merchant?.name ?? "Haggle"} on ${b.chain?.contractId ?? "NEAR"} · checked in ${(r.ms / 1000).toFixed(1)} s, in this browser.`;
    $("list").innerHTML = r.checks
      .map((c) => `<li class="${c.ok ? "" : "no"}"><span>${esc(c.label)}${c.detail ? `<small>${esc(c.detail)}</small>` : ""}</span></li>`)
      .join("");
  } catch (e) {
    $("badge").className = "badge bad";
    $("badge").textContent = "Couldn't check this proof";
    $("summary").textContent = (e as Error).message;
  }
}

const file = $<HTMLInputElement>("file");
file.addEventListener("change", async () => {
  const f = file.files?.[0];
  if (f) await run(await f.text(), f.name);
});
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const f = e.dataTransfer?.files?.[0];
  if (f) await run(await f.text(), f.name);
});
$("sample").addEventListener("click", async () => run(await (await fetch(sampleUrl)).text(), "the sample proof"));
if (location.hash === "#sample") $("sample").click();
