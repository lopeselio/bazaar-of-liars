import type { SelfCheck, SelfCheckResult } from "../selfcheck";

export function CheckList({ checks }: { checks: SelfCheck[] }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.id} className={c.ok ? "" : "no"}>
          <span>
            {c.label}
            {c.detail ? <small>{c.detail}</small> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Verdict({ result }: { result: SelfCheckResult }) {
  const { failed, checks, ms } = result;
  return (
    <p className={`badge ${failed ? "bad" : "good"}`} role="status">
      {failed ? `✗ ${failed} of ${checks.length} checks failed` : `✓ All ${checks.length} checks passed`}
      <span className="when"> · in this browser, {(ms / 1000).toFixed(1)} s</span>
    </p>
  );
}
