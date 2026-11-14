import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, loadSession, saveSession, type PlayerView } from "../../../web/src/api";
import { nearAuthAllowed, signInWithNearAuth, signOutOfNearAuth } from "./nearAuth";
import { signInWithWallet, signOutOfWallet, walletSessionGone } from "./wallet";

const shortAcct = (a: string) => (a.length > 24 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

type Step = { kind: "closed" } | { kind: "choose" } | { kind: "busy"; what: string } | { kind: "link"; account: PlayerView; guest: PlayerView };

/**
 * The account chip in the HUD and the sign-in sheet. Players sign in with a NEAR wallet (any
 * site) or with NEAR Auth (Google/email, where NEAR allows this site), then play as that account.
 */
export function Account({ guestId, toast }: { guestId: string; toast: (m: string) => void }) {
  const [session] = useState(loadSession);
  const [step, setStep] = useState<Step>({ kind: "closed" });
  const [nearAuth, setNearAuth] = useState<{ ok: boolean; origins: string[] } | null>(null);

  // The welcome and the walkthrough can open the sign-in sheet.
  useEffect(() => {
    const open = () => setStep((s) => (s.kind === "closed" ? { kind: "choose" } : s));
    addEventListener("bz:signin", open);
    return () => removeEventListener("bz:signin", open);
  }, []);

  useEffect(() => {
    if (step.kind === "choose" && !nearAuth) nearAuthAllowed().then(setNearAuth, () => setNearAuth({ ok: false, origins: [] }));
  }, [step.kind, nearAuth]);

  // A wallet session lives in a cookie: if the server no longer has it, drop the local marker.
  useEffect(() => {
    if (session && !session.token)
      void walletSessionGone(session.account).then((gone) => {
        if (gone) {
          saveSession(null);
          location.reload();
        }
      });
  }, [session]);

  /** After signing in: offer to bring the guest's progress along, once. */
  async function signedIn(r: { account: string; player: PlayerView }) {
    let guest: PlayerView | null = null;
    try {
      guest = await api.player(guestId);
    } catch {
      /* no guest progress to speak of */
    }
    const worth = guest && guest.known && (guest.worth > 0 || (guest.cred?.xp ?? 0) > 0);
    if (!worth || r.player.known) return location.reload();
    setStep({ kind: "link", account: r.player, guest: guest! });
  }

  async function run(what: string, f: () => Promise<{ account: string; player: PlayerView }>) {
    // Start f first (it may open a popup, which must happen inside the click), then update state.
    const p = f();
    setStep({ kind: "busy", what });
    try {
      await signedIn(await p);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      console.error("sign-in failed:", e);
      toast(`Sign-in didn't finish: ${msg}`);
      setStep({ kind: "choose" });
    }
  }

  if (session)
    return (
      <div id="bz-acct" className="bz-card">
        <a href={`https://testnet.nearblocks.io/address/${session.account}`} target="_blank" rel="noopener" title={session.account}>
          🔑 {shortAcct(session.account)}
        </a>
        <button
          type="button"
          onClick={async () => {
            saveSession(null);
            await Promise.all([signOutOfNearAuth(), signOutOfWallet()]);
            location.reload();
          }}
        >
          Sign out
        </button>
      </div>
    );

  return (
    <>
      <button id="bz-signin" className="bz-card" type="button" title="Your coins, goods and street cred live in your own NEAR account" onClick={() => setStep({ kind: "choose" })}>
        🔑 Sign in with NEAR
      </button>
      {/* On <body>: inside the HUD's stacking context the sheet would sit under the 3D canvas. */}
      {step.kind !== "closed" && createPortal(
        <div className="bz-sheet" role="dialog" aria-modal="true" aria-label="Sign in">
          <div className="bz-rv">
            {step.kind === "link" ? (
              <>
                <p className="eyebrow">Signed in · your NEAR account</p>
                <h3>Bring your guest progress?</h3>
                <p className="bz-note">
                  {step.guest.coins} coins, {Object.values(step.guest.goods).reduce((a, b) => a + b, 0)} goods and {step.guest.cred?.xp ?? 0} XP move to {shortAcct(step.account.id)}, onchain. This can be done once.
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await api.linkGuest(guestId);
                    } catch (e) {
                      toast((e as Error).message);
                    }
                    location.reload();
                  }}
                >
                  Bring it
                </button>{" "}
                <button type="button" onClick={() => location.reload()}>
                  Start fresh
                </button>
              </>
            ) : (
              <>
                <p className="eyebrow">Testnet · no real funds</p>
                <h3>Sign in to own your progress</h3>
                <p className="bz-note">Your coins, goods (NEP-245) and street cred move into your own NEAR account. The game still relays every transaction, so you never pay gas.</p>
                <div className="bz-options">
                  <button type="button" disabled={step.kind === "busy"} onClick={() => void run("your wallet", signInWithWallet)}>
                    <strong>NEAR wallet</strong>
                    <small>HOT, Meteor, Intear, MyNearWallet and more · signs a one-time message, no transaction</small>
                  </button>
                  <button
                    type="button"
                    disabled={step.kind === "busy" || !nearAuth?.ok}
                    title={nearAuth && !nearAuth.ok ? `NEAR Auth's shared testnet sign-in only allows ${nearAuth.origins.join(", ")} for now` : undefined}
                    onClick={() => void run("NEAR Auth", signInWithNearAuth)}
                  >
                    <strong>Google or email (NEAR Auth)</strong>
                    <small>{nearAuth && !nearAuth.ok ? "Coming to this site soon. Use a NEAR wallet for now." : "Key held by NEAR's MPC network, no seed phrase"}</small>
                  </button>
                </div>
                {step.kind === "busy" && <p className="bz-note">Waiting for {step.what}…</p>}
                <button type="button" className="bz-close" onClick={() => setStep({ kind: "closed" })}>
                  Not now
                </button>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
