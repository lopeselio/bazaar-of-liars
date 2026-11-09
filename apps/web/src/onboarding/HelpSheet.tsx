import type { ReactNode } from "react";
import { Modal } from "./Modal";

export interface Help {
  title: string;
  /** [keys or gestures, what they do] */
  controls: [string[], string][];
  rules: ReactNode[];
  /** The other way to play (desert ↔ city), shown under the rules. */
  elsewhere?: { href: string; label: string; note: string };
}

/** The in-game help sheet: controls and the rules that matter, plus a way back into the guide. */
export function HelpSheet({ theme, help, onClose, onWelcome, onTour }: { theme: string; help: Help; onClose: () => void; onWelcome: () => void; onTour: () => void }) {
  return (
    <Modal
      theme={theme}
      label="How to play"
      className="ob-help"
      onKey={(e) => {
        if (e.key === "Escape" || e.key === "?") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header className="ob-help-head">
        <div>
          <p className="ob-eyebrow">How to play</p>
          <h2>{help.title}</h2>
        </div>
        <button type="button" className="ob-x" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="ob-help-grid">
        <section>
          <h4>Controls</h4>
          <dl className="ob-controls">
            {help.controls.map(([keys, what]) => (
              <div key={what}>
                <dt>
                  {keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section>
          <h4>The rules that matter</h4>
          <ul className="ob-rules">
            {help.rules.map((r, n) => (
              <li key={n}>{r}</li>
            ))}
          </ul>
        </section>
      </div>
      {help.elsewhere && (
        <p className="ob-elsewhere">
          <a href={help.elsewhere.href}>{help.elsewhere.label}</a> {help.elsewhere.note}
        </p>
      )}
      <div className="ob-actions">
        <button type="button" className="ob-btn" onClick={onWelcome}>
          Replay the welcome
        </button>
        <button type="button" className="ob-btn primary" data-autofocus onClick={onTour}>
          Start the walkthrough
        </button>
      </div>
    </Modal>
  );
}
