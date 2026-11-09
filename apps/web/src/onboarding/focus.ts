/**
 * Where focus goes when an overlay closes. After a keyboard open it returns to what had it (so
 * keyboard players keep their place); after a mouse or touch open nothing keeps it, because a
 * focused button would click again on Space, which in the city is jump.
 */
let lastInput: "keyboard" | "pointer" = "pointer";
if (typeof window !== "undefined") {
  addEventListener("pointerdown", () => (lastInput = "pointer"), true);
  addEventListener("keydown", (e) => {
    if (!e.repeat) lastInput = "keyboard";
  }, true);
}

/** Call when an overlay opens; call the returned function when it closes. */
export function holdFocus(): () => void {
  const before = document.activeElement as HTMLElement | null;
  const byKeyboard = lastInput === "keyboard";
  return () => {
    if (byKeyboard && before && before !== document.body && document.contains(before)) before.focus();
    else (document.activeElement as HTMLElement | null)?.blur?.();
  };
}

/** For buttons that shouldn't take focus from a mouse click (the game keeps the keyboard). */
export const noMouseFocus = (e: { preventDefault(): void }) => e.preventDefault();
