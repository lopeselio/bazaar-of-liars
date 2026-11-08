// Sign in with NEAR Auth: Google, email, … through NEAR Auth's Auth0 tenant, with the player's key
// held by NEAR's MPC network. Only on origins NEAR Auth's shared testnet client allows.
import type { Auth0Client } from "@auth0/auth0-spa-js";
import { api, saveSession, type PlayerView } from "../../../web/src/api";

let auth0: Auth0Client | null = null;
async function client() {
  if (auth0) return auth0;
  const [{ Auth0Client }, cfg] = await Promise.all([import("@auth0/auth0-spa-js"), api.authConfig()]);
  // The callback must match one of the client's allowed URLs exactly: the bare origin.
  auth0 = new Auth0Client({ domain: cfg.domain, clientId: cfg.clientId, authorizationParams: { redirect_uri: location.origin } });
  return auth0;
}

/** Is NEAR Auth usable from this page? */
export async function nearAuthAllowed(): Promise<{ ok: boolean; origins: string[] }> {
  const cfg = await api.authConfig();
  return { ok: cfg.origins.includes(location.origin), origins: cfg.origins };
}

export async function signInWithNearAuth(): Promise<{ account: string; player: PlayerView }> {
  const c = await client();
  // Picking a Google account or typing an email code easily takes more than Auth0's default 60 s.
  await c.loginWithPopup(undefined, { timeoutInSeconds: 300 });
  const claims = await c.getIdTokenClaims();
  if (!claims?.__raw) throw new Error("No ID token came back from the sign-in.");
  const s = await api.startSession(claims.__raw);
  saveSession({ account: s.account, publicKey: s.publicKey, token: s.token, exp: s.exp });
  return { account: s.account, player: s.player };
}

export async function signOutOfNearAuth() {
  try {
    await (await client()).logout({ openUrl: false });
  } catch {
    /* the local session is gone either way */
  }
}
