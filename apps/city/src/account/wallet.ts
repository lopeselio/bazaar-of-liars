// Sign in with a NEAR wallet (NEP-413 signed message). Works on any site, unlike NEAR Auth, whose
// shared testnet client only returns to the origins NEAR has allowed.
import { api, saveSession, type PlayerView } from "../../../web/src/api";

export type WalletId = "my-near-wallet" | "meteor-wallet";

export const WALLETS: { id: WalletId; name: string; note: string }[] = [
  { id: "my-near-wallet", name: "MyNearWallet", note: "Web wallet, opens in a popup" },
  { id: "meteor-wallet", name: "Meteor Wallet", note: "Extension or web wallet" },
];

/** The wallet selector (and the Buffer it expects) load only when someone signs in. */
async function selector() {
  // The wallet libraries were written for bundlers that polyfill Node globals; give them the two
  // they touch before they load.
  const { Buffer } = await import("buffer");
  const g = globalThis as { Buffer?: unknown; process?: { env: Record<string, string> } };
  g.Buffer ??= Buffer;
  g.process ??= { env: { NODE_ENV: "production" } };
  const [{ setupWalletSelector }, { setupMyNearWallet }, { setupMeteorWallet }] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/my-near-wallet"),
    import("@near-wallet-selector/meteor-wallet"),
  ]);
  const selector = await setupWalletSelector({ network: "testnet", modules: [setupMyNearWallet(), setupMeteorWallet()] });
  return { selector, Buffer };
}

/** Everything a sign-in click needs, loaded when the sheet opens: browsers only allow the wallet's
 * popup if it opens straight from the click, with nothing awaited first. */
export interface Prepared {
  wallets: Partial<Record<WalletId, Awaited<ReturnType<Awaited<ReturnType<typeof selector>>["selector"]["wallet"]>>>>;
  challenge: { nonce: string; message: string; recipient: string };
  nonce: Uint8Array;
  at: number;
}

const CHALLENGE_TTL_MS = 4 * 60_000; // the server's nonce lives 5 minutes

export async function prepareWalletSignIn(): Promise<Prepared> {
  const [{ selector: ws, Buffer }, challenge] = await Promise.all([selector(), api.walletChallenge()]);
  const wallets: Prepared["wallets"] = {};
  for (const w of WALLETS) wallets[w.id] = await ws.wallet(w.id);
  // The selector checks the nonce is a Buffer of 32 bytes.
  return { wallets, challenge, nonce: Buffer.from(challenge.nonce, "base64"), at: Date.now() };
}

export const isFresh = (p: Prepared | null) => !!p && Date.now() - p.at < CHALLENGE_TTL_MS;

/** Called straight from the click: the wallet's popup opens before anything is awaited. */
export async function signInWithWallet(p: Prepared, id: WalletId): Promise<{ account: string; player: PlayerView }> {
  const wallet = p.wallets[id];
  if (!wallet) throw new Error("That wallet didn't load. Try again.");
  const callbackUrl = location.origin + location.pathname;
  const signed = await wallet.signMessage({ message: p.challenge.message, recipient: p.challenge.recipient, nonce: p.nonce as never, callbackUrl });
  if (!signed?.signature) throw new Error("The wallet didn't return a signature.");
  const s = await api.walletSession({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: p.challenge.nonce, callbackUrl });
  saveSession({ account: s.account, publicKey: signed.publicKey, token: s.token, exp: s.exp });
  return { account: s.account, player: s.player };
}
