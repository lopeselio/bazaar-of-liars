// Sign in with a NEAR wallet through Better Auth's better-near-auth plugin (SIWN, NEP-413).
// NEAR Connect shows the wallet picker (HOT, Meteor, Intear, MyNearWallet, …); the wallet signs
// "Sign in to <this host>"; the server checks it and sets an HttpOnly session cookie.
import { createAuthClient } from "better-auth/client";
import { siwnClient } from "better-near-auth/client";
import { api, saveSession, type PlayerView } from "../../../web/src/api";

let client: ReturnType<typeof makeClient> | null = null;
function makeClient() {
  const host = location.host;
  return createAuthClient({
    baseURL: location.origin,
    basePath: "/api/ba",
    plugins: [siwnClient({ recipients: { testnet: host, mainnet: host }, networkId: "testnet" })],
  });
}
export const authClient = () => (client ??= makeClient());

/** The NEAR account of the current wallet session, or null. */
async function sessionAccount(): Promise<string | null> {
  const r = (await authClient().getSession()) as { data?: { user?: { nearAccount?: { accountId?: string }; name?: string } } | null };
  return r.data?.user?.nearAccount?.accountId ?? null;
}

/** Open the wallet picker, sign, and start playing as that account. */
export async function signInWithWallet(): Promise<{ account: string; player: PlayerView }> {
  await new Promise<void>((resolve, reject) => {
    void authClient()
      .signIn.near({ onSuccess: () => resolve(), onError: (e: { error?: { message?: string } } | Error) => reject(new Error(e instanceof Error ? e.message : (e.error?.message ?? "the wallet didn't sign"))) })
      .catch(reject);
  });
  const account = await sessionAccount();
  if (!account) throw new Error("Signed in, but no NEAR account came back. Try again.");
  // The cookie carries the session; remember who we are (no token) so the game plays as this account.
  saveSession({ account, publicKey: "", token: "", exp: Date.now() + 24 * 3_600_000 });
  return { account, player: await api.player(account) };
}

/** A remembered wallet session that the server no longer has (expired, signed out elsewhere). */
export async function walletSessionGone(account: string): Promise<boolean> {
  try {
    return (await sessionAccount()) !== account;
  } catch {
    return false; // can't tell: keep playing
  }
}

export async function signOutOfWallet() {
  try {
    await authClient().signOut();
  } catch {
    /* the local marker is cleared either way */
  }
}
