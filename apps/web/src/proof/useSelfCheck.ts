import { useCallback, useState } from "react";
import { checkBundleHere, type SelfCheckResult } from "../selfcheck";

export type CheckState = { status: "idle" } | { status: "checking"; name: string } | { status: "done"; name: string; result: SelfCheckResult } | { status: "error"; name: string; message: string };

/** Run the open-source verifier on a proof, client-side, and track where it got to. */
export function useSelfCheck() {
  const [state, setState] = useState<CheckState>({ status: "idle" });
  /** `load` returns the proof (or throws, e.g. on a file that isn't JSON). */
  const check = useCallback(async (name: string, load: () => unknown) => {
    setState({ status: "checking", name });
    try {
      setState({ status: "done", name, result: await checkBundleHere(await load()) });
    } catch (e) {
      setState({ status: "error", name, message: (e as Error).message });
    }
  }, []);
  return { state, check };
}
