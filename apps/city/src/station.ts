/**
 * Walk-up stations (a merchant's stall, a price board, the pier, an informant, the docks, a drop-off,
 * a player stall) each show a prompt like "F Haggle with Farrukh". The prompt is a button: its key
 * and a tap or click on it run the same action, so a phone can do everything a keyboard can.
 */

/** Runs the station's action if it can right now; returns true if it did something. */
export type StationAction = () => boolean;

/**
 * Wire one prompt button to its action: the key (KeyboardEvent.code) works as before, ignored while
 * typing in a text box, and a tap or click on the prompt runs the very same function.
 */
export function bindStation(prompt: HTMLElement, code: string, act: StationAction) {
  prompt.classList.add("bz-station");
  if (!prompt.querySelector(".bz-tap")) prompt.insertAdjacentHTML("afterbegin", '<i class="bz-tap" aria-hidden="true">Tap</i>');
  addEventListener("keydown", (e) => {
    if (e.code !== code || (e.target as HTMLElement)?.tagName === "INPUT") return;
    if (act()) e.preventDefault();
  });
  // No focus on press: a focused button would take Space (jump, brake, climb) away from the city.
  prompt.addEventListener("mousedown", (e) => e.preventDefault());
  prompt.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (prompt.hidden) return;
    act();
    prompt.blur();
  });
}
