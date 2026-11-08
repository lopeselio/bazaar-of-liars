/**
 * The player's account: guest by default; sign in with a NEAR wallet (NEP-413, any site) or with
 * NEAR Auth (Google/email, where NEAR allows the site). Rendered with React into the city HUD.
 */
import { createRoot } from "react-dom/client";
import { loadSession } from "../../web/src/api";
import { Account } from "./account/Account";

/** The id this browser plays as: the signed-in NEAR account, or the guest id. */
export function currentPlayer(guestId: string) {
  return loadSession()?.account ?? guestId;
}

export function initLogin(d: { hud: HTMLElement; guestId: string; toast: (m: string) => void }) {
  const host = document.createElement("div");
  host.className = "bz-account";
  d.hud.appendChild(host);
  createRoot(host).render(<Account guestId={d.guestId} toast={d.toast} />);
}
