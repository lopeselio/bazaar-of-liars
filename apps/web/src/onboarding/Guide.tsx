import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./onboarding.css";
import { HelpSheet, type Help } from "./HelpSheet";
import { noMouseFocus } from "./focus";
import { obStore, typingIn } from "./storage";
import { Tour, type TourStep } from "./Tour";
import { Welcome, type Slide } from "./Welcome";

export type { Help, Slide, TourStep };

export interface GuideConfig {
  /** Picks the look: "web" (the desert bazaar) or "city" (Canal Street). */
  theme: "web" | "city";
  /** localStorage prefix; `<key>.welcome` remembers the welcome was seen. */
  storageKey: string;
  /** Players who already know the game (e.g. saw the old intro) skip the first-run welcome. */
  seenBefore?: () => boolean;
  /** A function is called each time the welcome or help opens (e.g. to word it for touch or keys). */
  slides: Slide[] | (() => Slide[]);
  /** Built when the walkthrough starts, so steps can read live game state. */
  steps: () => TourStep[];
  help: Help | (() => Help);
  /** Class and content of the always-visible "How to play" button. */
  button: { className: string; content: ReactNode };
}

type Mode = "none" | "welcome" | "tour" | "help";

export function Guide({ cfg }: { cfg: GuideConfig }) {
  const seen = () => !!obStore.get(`${cfg.storageKey}.welcome`) || !!cfg.seenBefore?.();
  const [mode, setMode] = useState<Mode>(() => (seen() ? "none" : "welcome"));
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [tourRun, setTourRun] = useState(0);

  const markSeen = () => obStore.set(`${cfg.storageKey}.welcome`, "1");
  const startTour = () => {
    markSeen();
    setSteps(cfg.steps());
    setTourRun((n) => n + 1);
    setMode("tour");
  };
  const endTour = () => {
    obStore.set(`${cfg.storageKey}.tour`, "1");
    setMode("none");
  };

  // "?" opens the help sheet from anywhere (an open modal takes its own keys first).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "?" || typingIn(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      setMode((m) => (m === "help" ? "none" : "help"));
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, []);

  return (
    <>
      <button
        type="button"
        className={`ob-open ${cfg.button.className}`}
        title="How to play (?)"
        aria-label="How to play"
        aria-haspopup="dialog"
        aria-expanded={mode === "help"}
        onMouseDown={noMouseFocus}
        onClick={() => setMode((m) => (m === "help" ? "none" : "help"))}
      >
        {cfg.button.content}
      </button>
      {mode === "welcome" && (
        <Welcome
          theme={cfg.theme}
          slides={typeof cfg.slides === "function" ? cfg.slides() : cfg.slides}
          onSkip={() => {
            markSeen();
            setMode("none");
          }}
          onTour={startTour}
        />
      )}
      {mode === "tour" && <Tour key={tourRun} theme={cfg.theme} steps={steps} onDone={endTour} />}
      {mode === "help" && <HelpSheet theme={cfg.theme} help={typeof cfg.help === "function" ? cfg.help() : cfg.help} onClose={() => setMode("none")} onWelcome={() => setMode("welcome")} onTour={startTour} />}
    </>
  );
}

/** Render the guide's button into `host`; its overlays go on <body>. Shows the welcome on first run. */
export function mountGuide(host: HTMLElement, cfg: GuideConfig) {
  createRoot(host).render(<Guide cfg={cfg} />);
}
