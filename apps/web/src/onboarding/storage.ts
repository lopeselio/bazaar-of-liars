/** localStorage that never throws: private mode, blocked storage or a sandboxed frame just forget. */
export const obStore = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* not remembered, which only means the welcome may show again */
    }
  },
};

/** True while the player is typing in a field, so shortcuts like "?" leave the keystroke alone. */
export function typingIn(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}
