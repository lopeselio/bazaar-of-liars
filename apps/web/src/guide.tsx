/** The bazaar's onboarding: first-run welcome, walkthrough and help sheet (see ./onboarding). */
import { mountGuide, type GuideConfig, type TourStep } from "./onboarding/Guide";

const open = (id: string) => {
  const el = document.getElementById(id);
  return !!el && !el.hidden;
};
const panelOpen = () => open("panel");
const haggling = () => panelOpen() && !document.querySelector<HTMLElement>(".ask-row")?.hidden;

/** True once the player has said something more than when the step began. */
function saidSomething() {
  let start = -1;
  return () => {
    const n = document.querySelectorAll("#p-log .msg.player").length;
    if (start < 0) start = n;
    return n > start;
  };
}

const steps = (): TourStep[] => [
  {
    target: ".label",
    title: "Pick a merchant",
    body: <p>Each stall sells one good and buys another. The tag says which.</p>,
    tryIt: "Click a merchant's name tag.",
    done: panelOpen,
  },
  {
    target: ["#p-choose button:not(:disabled)", "#p-choose"],
    title: "Buy or sell",
    body: <p>Buy their good with your coins, or sell them something you bought at another stall. They might secretly want it badly.</p>,
    tryIt: "Choose Buy.",
    when: panelOpen,
    done: haggling,
  },
  {
    target: ".ask-row",
    title: "Their price, and their secret",
    body: (
      <p>
        This is what they're asking. Their real limit was <b>sealed on NEAR</b> before they spoke, so it can't change. Watch their hands in the scene: a firm stance means you're
        close to their limit, fidgeting means they need the sale, losing patience means they may walk.
      </p>
    ),
    when: haggling,
  },
  {
    target: "#p-input",
    title: "Make an offer",
    body: <p>Name a price, in numbers or plain words. A flaw or a cheaper stall's price backs it up, but talk with no number never moves them.</p>,
    tryIt: "Type “I'll give you 20” and press Say.",
    when: haggling,
    done: saidSomething(),
  },
  {
    target: ["#q-call:not([hidden])", ".quick"],
    title: "Call the bluff, or close the deal",
    body: (
      <p>
        When they swear “not below 30”, <b>Call the bluff</b> appears. Catch a liar and the price collapses; accuse an honest merchant and the price goes up and becomes final, or they walk away.{" "}
        <b>Take it</b> accepts their price; <b>Walk away</b> ends the haggle.
      </p>
    ),
    when: haggling,
  },
  {
    target: "#purse",
    title: "Your purse",
    body: <p>Your coins and goods, read from the NEAR contract. Buy low at one stall, sell high at another, and grow it.</p>,
  },
  {
    target: "#day",
    title: "The market day",
    body: <p>A few haggles before sundown. Then you see your day's profit and the top traders, and start the next day.</p>,
  },
  {
    target: "#how",
    title: "Check it's fair",
    body: <p>After every haggle the reveal card shows their real limit and every bluff, and you can verify it all yourself. This explains how.</p>,
  },
  {
    target: ".ob-open",
    title: "Help is always here",
    body: <p>Controls, the rules, and this walkthrough again. Press ? at any time.</p>,
  },
];

const cfg: GuideConfig = {
  theme: "web",
  storageKey: "bazaar.guide.web",
  // Players who clicked through the old intro already know the basics.
  seenBefore: () => {
    try {
      return !!localStorage.getItem("bazaar.seenIntro");
    } catch {
      return false;
    }
  },
  slides: [
    {
      art: "🪔",
      eyebrow: "Bazaar of Liars",
      title: "The merchants lie. The bazaar can't.",
      body: (
        <p>
          Haggle with AI merchants who <strong>bluff about their prices</strong>. Every merchant's secret is <strong>sealed on NEAR</strong> before you speak, and every word comes
          from an AI in a verified enclave, so you can prove afterwards it was fair.
        </p>
      ),
    },
    {
      art: "🤝",
      eyebrow: "How a haggle works",
      title: "Offer, read, call, deal",
      body: (
        <ul>
          <li>
            <strong>Name a price.</strong> A flaw or a cheaper stall backs it up; talk with no number never moves them.
          </li>
          <li>
            <strong>Read the tells.</strong> A merchant who looks firm is close to their limit; one who fidgets needs the sale.
          </li>
          <li>
            <strong>Call the bluff</strong> when they swear “I can't go lower”. Right, and the price collapses. Wrong, and it goes up, or they walk.
          </li>
          <li>
            <strong>Take the deal</strong>, then see their real limit and every lie they told.
          </li>
        </ul>
      ),
    },
    {
      art: "🌅",
      eyebrow: "The market",
      title: "Buy low, sell high, before sundown",
      body: (
        <ul>
          <li>
            You start with <strong>coins</strong>. Each stall sells one good and buys another.
          </li>
          <li>
            A market day has <strong>six haggles</strong>. The best traders by peak purse are listed onchain.
          </li>
          <li>
            Merchants <strong>remember you</strong>: lowball them and prices get worse, deal often and you get a friend's price.
          </li>
          <li>
            On <strong>Canal Street</strong> (<code>/city/</code>) the same merchants trade in a walkable city, with jobs, auctions and stalls of your own.
          </li>
        </ul>
      ),
    },
    {
      art: "🧭",
      eyebrow: "Where to start",
      title: "Try Tobin and his brass lamp",
      body: (
        <p>
          Click <strong>Tobin of the Lamps</strong>, choose <strong>Buy</strong>, and offer about half his price. No wallet, no gas. Want a quick tour of the screen first?
        </p>
      ),
    },
  ],
  steps,
  help: {
    title: "The bazaar",
    controls: [
      [["Click"], "a merchant's tag to walk up to the stall"],
      [["Type", "Enter"], "name a price (talk alone never moves it)"],
      [["Take it"], "accept the price on the table"],
      [["Call"], "call the bluff when they claim a limit"],
      [["Walk"], "walk away (Esc closes panels)"],
      [["?"], "open this sheet"],
    ],
    rules: [
      <>
        Each merchant has a <b>secret limit</b> and a need, sealed on NEAR before the haggle starts.
      </>,
      <>
        A rules engine, not the AI, decides every price. The AI only does the talking.
      </>,
      <>
        <b>Catch a bluff</b> and the price drops toward their real limit. <b>Accuse an honest merchant</b> and they raise the price and make it final, or walk.
      </>,
      <>
        Tells leak how close they are to their limit: firm means close, fidgeting means they need the sale, losing patience means they may walk.
      </>,
      <>
        Six haggles per market day; your coins, goods and each merchant's memory of you live in the contract.
      </>,
      <>
        After each haggle, <b>Fair play verified</b> opens the evidence; <b>Check it in your browser</b> re-runs it without our server.
      </>,
    ],
  },
  button: {
    className: "chip guide-chip",
    content: (
      <>
        <b aria-hidden="true">?</b>
        <span className="guide-word"> How to play</span>
      </>
    ),
  },
};

/** Put the "How to play" chip first in the top bar and show the welcome on a first visit. */
export function initGuide() {
  const bar = document.querySelector(".hud-right");
  if (!bar) return;
  const host = document.createElement("span");
  host.className = "guide-host";
  bar.prepend(host);
  mountGuide(host, cfg);
}
