import { useState, type DragEvent } from "react";
import sampleUrl from "../../../../examples/sample-haggle.json?url";
import { CheckList, Verdict } from "./CheckList";
import { useSelfCheck } from "./useSelfCheck";

/** /verify.html: drop any proof (or the sample) and check it in this browser. */
export function VerifyPage() {
  const { state, check } = useSelfCheck();
  const [over, setOver] = useState(false);

  const parse = (text: string) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("that file isn't JSON");
    }
  };
  const checkFile = (f: File | undefined) => f && void check(f.name, async () => parse(await f.text()));
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    checkFile(e.dataTransfer.files[0]);
  };
  const busy = state.status === "checking";

  return (
    <main className="vwrap">
      <a className="vback" href="/">
        ← Back to the bazaar
      </a>
      <h1>Check a haggle yourself</h1>
      <p className="sub">
        Drop a proof you downloaded after a haggle, or load our sample. This page runs the same open-source verifier as{" "}
        <code>pnpm verify:haggle</code>, here in your browser. It reads NEAR's public RPC directly and never sends the proof to our server.
      </p>
      <label
        className={`vdrop${over ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input type="file" accept="application/json,.json" hidden onChange={(e) => checkFile(e.target.files?.[0])} />
        <strong>Drop a proof file here</strong>
        <span>or click to choose one</span>
      </label>
      <button className="btn" type="button" disabled={busy} onClick={() => void check("the sample proof", async () => parse(await (await fetch(sampleUrl)).text()))}>
        Check the sample proof
      </button>
      {state.status !== "idle" && (
        <section className="vout" aria-live="polite">
          {state.status === "checking" && <p className="badge">Checking {state.name}: reading the contract and transactions from NEAR testnet…</p>}
          {state.status === "error" && (
            <p className="badge bad">
              Couldn't check {state.name}: {state.message}
            </p>
          )}
          {state.status === "done" && (
            <>
              <Verdict result={state.result} />
              <p className="sub">{state.name}</p>
              <CheckList checks={state.result.checks} />
            </>
          )}
        </section>
      )}
    </main>
  );
}
