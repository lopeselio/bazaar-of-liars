/**
 * Room for the HUD column. The street's banners (job tracker, street event, broke, cargo ship,
 * walkthrough) are centred at the top and stack on a wide screen. On a narrow one they land on
 * the HUD column's player card. Twice a second this checks each visible banner against the
 * column: if there's room to the right of the column, the banner moves there; otherwise the
 * column moves down by the overlap (`--bz-banner-push`). Nothing moves when nothing overlaps.
 */
const BANNERS = ["bz-track", "bz-event", "bz-broke", "bz-ship", "bz-guide"];

export function initHudRoom() {
  const fit = () => {
    const hud = document.getElementById("bz-hud");
    if (!hud) return;
    const banners = BANNERS.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    // Measure from where everything sits on its own.
    hud.style.removeProperty("--bz-banner-push");
    for (const b of banners) {
      b.style.removeProperty("left");
      b.style.removeProperty("transform");
    }
    if (hud.hidden) return;
    const h = hud.getBoundingClientRect();
    let push = 0;
    for (const b of banners) {
      if (b.hidden || getComputedStyle(b).display === "none") continue;
      const r = b.getBoundingClientRect();
      const overlaps = r.left < h.right && r.right > h.left && r.top < h.bottom && r.bottom > h.top;
      if (!overlaps) continue;
      if (innerWidth - h.right - 24 >= r.width) {
        b.style.left = `${Math.round(h.right + 12)}px`;
        b.style.transform = "none";
      } else {
        push = Math.max(push, Math.ceil(r.bottom + 8 - h.top));
      }
    }
    if (push > 0) hud.style.setProperty("--bz-banner-push", `${push}px`);
  };
  addEventListener("resize", fit);
  setInterval(fit, 500);
  fit();
}
