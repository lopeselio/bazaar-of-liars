/**
 * Sign in with NEAR Auth: Google, email, … through NEAR Auth's Auth0 tenant, with the player's key
 * held by NEAR's MPC network (no seed phrase, nothing to install).
 *
 * The popup returns an ID token; the server checks it and works out which NEAR account that
 * identity controls (the implicit account of the key NEAR Auth derives for it). From then on the
 * player plays as that account: coins, goods (NEP-245 tokens) and street cred are theirs onchain.
 * A guest's progress can be brought along once.
 */
import type { Auth0Client } from "@auth0/auth0-spa-js";
import { api, loadSession, saveSession, type PlayerView } from "../../web/src/api";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const shortAcct = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The id this browser plays as: the signed-in NEAR account, or the guest id. */
export function currentPlayer(guestId: string) {
  return loadSession()?.account ?? guestId;
}

export function initLogin(d: { hud: HTMLElement; guestId: string; toast: (m: string) => void }) {
  const session = loadSession();
  d.hud.insertAdjacentHTML(
    "beforeend",
    session
      ? `<div id="bz-acct" class="bz-card"><a href="https://testnet.nearblocks.io/address/${session.account}" target="_blank" rel="noopener" title="${session.account}">🔑 ${shortAcct(session.account)}</a><button type="button" id="bz-signout">Sign out</button></div>`
      : `<button id="bz-signin" class="bz-card" type="button" title="Sign in with NEAR Auth: your coins, goods and street cred live in your own NEAR account">🔑 Sign in · Google or email</button>`,
  );
  document.body.insertAdjacentHTML("beforeend", `<div id="bz-link" hidden></div>`);

  let auth0: Auth0Client | null = null;
  async function client() {
    if (auth0) return auth0;
    // Loaded on first use, so the city boots without it.
    const [{ Auth0Client }, cfg] = await Promise.all([import("@auth0/auth0-spa-js"), api.authConfig()]);
    // The callback must match one of the client's allowed URLs exactly: the bare origin.
    auth0 = new Auth0Client({ domain: cfg.domain, clientId: cfg.clientId, authorizationParams: { redirect_uri: location.origin } });
    return auth0;
  }

  async function signIn() {
    const b = $("bz-signin") as HTMLButtonElement;
    b.disabled = true;
    b.textContent = "🔑 Signing in…";
    try {
      const c = await client();
      await c.loginWithPopup();
      const claims = await c.getIdTokenClaims();
      if (!claims?.__raw) throw new Error("No ID token came back from the sign-in.");
      const s = await api.startSession(claims.__raw);
      saveSession({ account: s.account, publicKey: s.publicKey, token: s.token, exp: s.exp });
      await offerLink(s.player);
    } catch (e) {
      d.toast(`Sign-in didn't finish: ${(e as Error).message}`);
      b.disabled = false;
      b.textContent = "🔑 Sign in · Google or email";
    }
  }

  /** Offer to bring the guest's progress to the new account, then start playing as it. */
  async function offerLink(account: PlayerView) {
    let guest: PlayerView | null = null;
    try {
      guest = await api.player(d.guestId);
    } catch {
      /* no guest progress to speak of */
    }
    const worth = guest && guest.known && (guest.worth > 0 || (guest.cred?.xp ?? 0) > 0);
    if (!worth || account.known) {
      location.reload();
      return;
    }
    $("bz-link").innerHTML = `
      <div class="bz-rv">
        <p class="eyebrow">Signed in · your NEAR account</p>
        <h3>Bring your guest progress?</h3>
        <p class="bz-note">${guest!.coins} coins, ${Object.values(guest!.goods).reduce((a, b) => a + b, 0)} goods and ${guest!.cred?.xp ?? 0} XP move to ${shortAcct(account.id)}, onchain. This can be done once.</p>
        <button type="button" id="bz-link-yes">Bring it</button> <button type="button" id="bz-link-no">Start fresh</button>
      </div>`;
    $("bz-link").hidden = false;
    $("bz-link-no").addEventListener("click", () => location.reload());
    $("bz-link-yes").addEventListener("click", async () => {
      ($("bz-link-yes") as HTMLButtonElement).disabled = true;
      try {
        await api.linkGuest(d.guestId);
      } catch (e) {
        d.toast((e as Error).message);
      }
      location.reload();
    });
  }

  async function signOut() {
    saveSession(null);
    try {
      await (await client()).logout({ openUrl: false });
    } catch {
      /* the local session is gone either way */
    }
    location.reload();
  }

  $("bz-signin")?.addEventListener("click", () => void signIn());
  // NEAR Auth's Auth0 client only returns to the origins it allows; say so instead of failing.
  if (!session)
    void api
      .authConfig()
      .then((cfg) => {
        if (cfg.origins.includes(location.origin)) return;
        const b = $("bz-signin") as HTMLButtonElement;
        b.disabled = true;
        b.textContent = "🔑 Sign-in: run locally on :3000";
        b.title = `NEAR Auth's shared testnet sign-in only allows ${cfg.origins.join(", ")} for now. Run the game there to sign in; here you play as a guest.`;
      })
      .catch(() => {});
  $("bz-signout")?.addEventListener("click", () => void signOut());
}
