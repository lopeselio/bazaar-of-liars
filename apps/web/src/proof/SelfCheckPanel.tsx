import { CheckList, Verdict } from "./CheckList";
import { useSelfCheck } from "./useSelfCheck";

/** In the game's evidence drawer: re-run the server's checks on this haggle's proof, client-side. */
export function SelfCheckPanel({ bundle, onDownload }: { bundle: unknown; onDownload: () => void }) {
  const { state, check } = useSelfCheck();
  return (
    <div className="selfcheck">
      <div className="row">
        <button className="btn" type="button" disabled={state.status === "checking" || state.status === "done"} onClick={() => void check("this haggle", () => bundle)}>
          {state.status === "checking" ? "Checking…" : state.status === "done" ? "Checked here" : "Check it in your browser"}
        </button>{" "}
        <button className="btn ghost" type="button" onClick={onDownload}>
          Download proof
        </button>
      </div>
      {state.status === "error" && <p className="sub">Couldn't run the check here: {state.message}</p>}
      {state.status === "done" && (
        <>
          <Verdict result={state.result} />
          <CheckList checks={state.result.checks} />
        </>
      )}
    </div>
  );
}
