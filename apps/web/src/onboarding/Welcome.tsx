import { useEffect, useState, type ReactNode } from "react";
import { Modal, onButton } from "./Modal";

export interface Slide {
  /** A big emoji or symbol at the top of the card. */
  art: string;
  eyebrow: string;
  title: string;
  body: ReactNode;
}

/**
 * The first-run welcome: a few short cards with Skip/Next, progress dots and keys
 * (→ or Enter for next, ← for back, Esc to skip). The last card offers the walkthrough.
 */
export function Welcome({ theme, slides, onSkip, onTour }: { theme: string; slides: Slide[]; onSkip: () => void; onTour: () => void }) {
  const [i, setI] = useState(0);
  const last = i === slides.length - 1;
  const s = slides[i];
  const go = (n: number) => setI(Math.max(0, Math.min(slides.length - 1, n)));

  // When Next turns into the last card's buttons, keep the keyboard focus on the main action.
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body || !a.closest(".ob-welcome")) document.querySelector<HTMLElement>(".ob-welcome [data-autofocus]")?.focus();
  }, [i]);

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onSkip();
    } else if (e.key === "ArrowRight" || (e.key === "Enter" && !onButton())) {
      e.preventDefault();
      if (last) onTour();
      else go(i + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(i - 1);
    }
  }

  return (
    <Modal theme={theme} label="Welcome to the Bazaar of Liars" className="ob-welcome" onKey={onKey}>
      <button type="button" className="ob-skip" onClick={onSkip}>
        Skip
      </button>
      <div className="ob-slide" key={i} aria-live="polite">
        <div className="ob-art" aria-hidden="true">
          {s.art}
        </div>
        <p className="ob-eyebrow">{s.eyebrow}</p>
        <h2>{s.title}</h2>
        <div className="ob-body">{s.body}</div>
      </div>
      <div className="ob-dots" role="group" aria-label="Progress">
        {slides.map((x, n) => (
          <button key={n} type="button" className={n === i ? "on" : ""} aria-label={`Card ${n + 1} of ${slides.length}: ${x.title}`} aria-current={n === i ? "step" : undefined} onClick={() => go(n)} />
        ))}
      </div>
      <div className="ob-actions">
        {i > 0 ? (
          <button type="button" className="ob-btn" onClick={() => go(i - 1)}>
            Back
          </button>
        ) : (
          <span />
        )}
        {last ? (
          <span className="ob-pair">
            <button type="button" className="ob-btn" onClick={onSkip}>
              I'll explore
            </button>
            <button type="button" className="ob-btn primary" data-autofocus onClick={onTour}>
              Show me around
            </button>
          </span>
        ) : (
          <button type="button" className="ob-btn primary" data-autofocus key="next" onClick={() => go(i + 1)}>
            Next
          </button>
        )}
      </div>
      <p className="ob-keys" aria-hidden="true">
        <kbd>←</kbd> <kbd>→</kbd> to move · <kbd>Esc</kbd> to skip
      </p>
    </Modal>
  );
}
