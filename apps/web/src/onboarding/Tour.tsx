import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { holdFocus, noMouseFocus } from "./focus";
import { typingIn } from "./storage";

export interface TourStep {
  /** CSS selectors for the real UI element; the first one that's on screen wins. None: a centred card. */
  target?: string | string[];
  title: string;
  body: ReactNode;
  /** What to do to move on by playing ("Press F"). Shown under the instruction. */
  tryIt?: string;
  /** The real action: once this is true, the walkthrough moves on by itself. */
  done?: () => boolean;
  /** Key codes (KeyboardEvent.code) that also count as doing it. */
  keys?: string[];
  /** Only shown while this holds (say, the haggle panel is open); otherwise skipped at once. */
  when?: () => boolean;
}

type Box = { x: number; y: number; w: number; h: number };

/** How long a step waits for its target to appear before it's skipped. */
const MISSING_MS = 1200;
const PAD = 6;

/** Is this element really on screen (not hidden, not display:none, not zero-sized)? */
function shown(el: Element | null): el is HTMLElement {
  if (!el || (el as HTMLElement).closest("[hidden]")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

function find(target: TourStep["target"]): HTMLElement | null {
  for (const sel of typeof target === "string" ? [target] : (target ?? [])) {
    for (const el of document.querySelectorAll(sel)) if (shown(el)) return el as HTMLElement;
  }
  return null;
}

/**
 * Coach marks: a spotlight around a real UI element and a short instruction beside it, with
 * Back/Next/Skip. The page stays live underneath, so the player can do the real thing, and a step
 * with `done` or `keys` advances on its own when they do. A step whose element isn't on screen is
 * skipped, in whichever direction the player was going.
 */
export function Tour({ theme, steps, onDone }: { theme: string; steps: TourStep[]; onDone: () => void }) {
  const [at, setAt] = useState({ i: 0, dir: 1 });
  const [box, setBox] = useState<Box | null>(null);
  const [card, setCard] = useState<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const step = steps[at.i] as TourStep | undefined;

  const move = (dir: number) =>
    setAt((a) => {
      const i = a.i + dir;
      if (i >= steps.length) {
        queueMicrotask(() => doneRef.current());
        return a;
      }
      return { i: Math.max(0, i), dir: i < 0 ? 1 : dir };
    });

  // Follow the target every frame (stall tags move with the camera), skip it if it never shows,
  // and move on when the real action has happened.
  useEffect(() => {
    if (!step) return;
    let raf = 0;
    let key = "";
    let advanced = false;
    const since = performance.now();
    if (step.when && !step.when()) {
      move(at.dir);
      return;
    }
    let frame = 0;
    const tick = () => {
      // Measuring every third frame is plenty to follow a moving tag.
      if (frame++ % 3) {
        raf = requestAnimationFrame(tick);
        return;
      }
      // Going back, let the player reread a step even if they've already done it.
      if (at.dir > 0 && !advanced && step.done?.()) {
        advanced = true;
        return move(1);
      }
      if (step.target) {
        const el = find(step.target);
        if (!el) {
          if (performance.now() - since > MISSING_MS && !advanced) {
            advanced = true;
            return move(at.dir);
          }
        } else {
          const r = el.getBoundingClientRect();
          const b = { x: Math.round(r.left - PAD), y: Math.round(r.top - PAD), w: Math.round(r.width + PAD * 2), h: Math.round(r.height + PAD * 2) };
          const k = `${b.x},${b.y},${b.w},${b.h}`;
          if (k !== key) {
            key = k;
            setBox(b);
          }
        }
      } else if (key !== "none") {
        key = "none";
        setBox(null);
      }
      raf = requestAnimationFrame(tick);
    };
    setBox(null);
    tick();
    return () => cancelAnimationFrame(raf);
  }, [at]);

  // When the tour closes, don't leave its Next button focused (Space would press it again).
  useEffect(() => holdFocus(), []);

  // Esc ends the tour (the game still sees the key, e.g. to close a stall).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") doneRef.current();
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, []);

  // Pressing the step's key (F, J, WASD…) counts as doing it. The game still gets the key.
  useEffect(() => {
    if (!step?.keys?.length) return;
    let t = 0;
    const h = (e: KeyboardEvent) => {
      if (typingIn(e) || !step.keys!.includes(e.code)) return;
      clearTimeout(t);
      t = window.setTimeout(() => move(1), 450);
    };
    addEventListener("keydown", h);
    return () => {
      removeEventListener("keydown", h);
      clearTimeout(t);
    };
  }, [at]);

  // Put the card below the target if it fits, else above, else beside it; centred without one.
  useLayoutEffect(() => {
    const c = cardRef.current;
    if (!c) return;
    const w = c.offsetWidth;
    const h = c.offsetHeight;
    const M = 12;
    if (!box) return setCard({ x: (innerWidth - w) / 2, y: Math.max(M, innerHeight * 0.62 - h / 2) });
    let x = box.x + box.w / 2 - w / 2;
    let y: number;
    if (box.y + box.h + M + h < innerHeight) y = box.y + box.h + M;
    else if (box.y - M - h > 0) y = box.y - M - h;
    else if (box.x + box.w + M + w < innerWidth) {
      x = box.x + box.w + M;
      y = box.y;
    } else if (box.x - M - w > 0) {
      x = box.x - M - w;
      y = box.y;
    } else y = innerHeight - h - M;
    x = Math.max(M, Math.min(innerWidth - w - M, x));
    y = Math.max(M, Math.min(innerHeight - h - M, y));
    setCard({ x, y });
  }, [box, at]);

  useEffect(() => {
    const h = () => setBox((b) => (b ? { ...b } : b));
    addEventListener("resize", h);
    return () => removeEventListener("resize", h);
  }, []);

  if (!step) return null;
  // Waiting for the target to show up: no card yet, so it doesn't flash and then vanish.
  if (step.target && !box) return null;
  const lastStep = at.i === steps.length - 1;
  return createPortal(
    <div className={`ob ob-${theme} ob-tour`}>
      {box && <div className="ob-spot" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} aria-hidden="true" />}
      <div
        ref={cardRef}
        className="ob-coach"
        role="dialog"
        aria-modal="false"
        aria-label={`Walkthrough, step ${at.i + 1} of ${steps.length}`}
        style={card ? { left: card.x, top: card.y } : { visibility: "hidden" }}
      >
        <p className="ob-eyebrow">
          How to play · {at.i + 1}/{steps.length}
        </p>
        <h3>{step.title}</h3>
        <div className="ob-body" aria-live="polite">
          {step.body}
        </div>
        {step.tryIt && <p className="ob-try">{step.tryIt}</p>}
        <div className="ob-actions">
          <button type="button" className="ob-link" onMouseDown={noMouseFocus} onClick={() => doneRef.current()}>
            Skip tour
          </button>
          <span className="ob-pair">
            {at.i > 0 && (
              <button type="button" className="ob-btn" onMouseDown={noMouseFocus} onClick={() => move(-1)}>
                Back
              </button>
            )}
            <button type="button" className="ob-btn primary" onMouseDown={noMouseFocus} onClick={() => move(1)}>
              {lastStep ? "Done" : "Next"}
            </button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
