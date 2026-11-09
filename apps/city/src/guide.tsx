/** Canal Street's onboarding: first-run welcome, walkthrough and help sheet (shared code in apps/web/src/onboarding). */
import { mountGuide, type GuideConfig, type TourStep } from "../../web/src/onboarding/Guide";

const open = (id: string) => {
  const el = document.getElementById(id);
  return !!el && !el.hidden;
};
const MOVE = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

const steps = (): TourStep[] => [
  {
    title: "Walk the city",
    body: (
      <p>
        <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or the arrow keys to move, drag to look around. <kbd>1</kbd> walk, <kbd>2</kbd> cab, <kbd>3</kbd> bike, <kbd>4</kbd>{" "}
        helicopter.
      </p>
    ),
    tryIt: "Press W to take a step.",
    keys: MOVE,
  },
  {
    target: ["#bz-prompt:not([hidden])", ".bz-tag", "#bz-go"],
    title: "Find a stall",
    body: (
      <p>
        The merchants' stalls line Canal Street. Walk up until <kbd>F</kbd> <b>Haggle with…</b> appears, then press <kbd>F</kbd>. Lost? <b>⇢ Canal St</b> takes you back.
      </p>
    ),
    tryIt: "Walk to a stall and press F.",
    done: () => open("bz-panel"),
  },
  {
    target: "#bz-panel",
    title: "Haggle",
    body: (
      <p>
        Each merchant is an AI agent with its own NEAR account. Choose buy or sell, then offer with the quick buttons or type. When they swear a limit, <b>Call the bluff</b>{" "}
        appears: catch a liar and the price collapses; accuse an honest one and it rises, or they walk. <kbd>Esc</kbd> leaves.
      </p>
    ),
    when: () => open("bz-panel"),
  },
  {
    target: ".bz-purse",
    title: "Your purse",
    body: <p>Coins and the goods you carry, read from the contract. Buy low at one stall or board, sell high at another.</p>,
  },
  {
    target: "#bz-day",
    title: "Haggles left today",
    body: <p>A market day has a few haggles. When they're gone, a stall offers to start the next day.</p>,
  },
  {
    target: "#bz-cred",
    title: "Street cred",
    body: <p>Every deal and delivery earns XP, kept onchain; catching a bluff earns extra. Levels unlock express jobs and, at level 3, a stall of your own. Click it to see what's next.</p>,
  },
  {
    target: "#bz-jobs-btn",
    title: "Delivery jobs",
    body: <p>Customers across Manhattan lock a bounty onchain for goods from Canal Street. Take one, buy the good, and deliver it before the clock runs out.</p>,
    tryIt: "Press J to open the board (J or Esc closes it).",
    keys: ["KeyJ"],
    done: () => open("bz-board"),
  },
  {
    target: "#bz-route-chip",
    title: "Trade routes",
    body: (
      <p>
        Price boards around the city buy and sell at posted prices: press <kbd>T</kbd> at one. This chip shows the best spread right now; click it for directions.
      </p>
    ),
  },
  {
    target: "#bz-wire",
    title: "The Canal St wire",
    body: <p>What the agents are doing on their own: restocking, hauling, flipping goods, bartering. Each line links to its transaction.</p>,
  },
  {
    title: "More around town",
    body: (
      <ul>
        <li>
          <kbd>G</kbd> in the gold beam at <b>Pier 34</b>: bid on a cargo ship, sealed onchain.
        </li>
        <li>
          <kbd>F</kbd> next to a hooded <b>informant</b>: buy a tip. Lies are refunded.
        </li>
        <li>
          <kbd>F</kbd> at the docks when you're broke: a day's work for Auntie Wu.
        </li>
        <li>
          Banners announce <b>street events</b>: festivals, shortages, inspector raids.
        </li>
      </ul>
    ),
  },
  {
    target: ["#bz-signin", "#bz-acct"],
    title: "Own your progress",
    body: (
      <p>
        You play as a guest. <b>🔑 Sign in</b> with a NEAR wallet, or Google or email through NEAR Auth, and your coins, goods and cred move to your own testnet account. Still no gas.
      </p>
    ),
  },
  {
    target: ".ob-open",
    title: "Help is always here",
    body: <p>Every key, the rules, and this walkthrough again. Press ? at any time.</p>,
  },
];

const cfg: GuideConfig = {
  theme: "city",
  storageKey: "bazaar.guide.city",
  slides: [
    {
      art: "🏮",
      eyebrow: "Bazaar of Liars · Canal Street",
      title: "Haggle with merchants who bluff",
      body: (
        <p>
          Every trader here is an <strong>AI agent with its own NEAR wallet</strong>. They lie about their prices. Their secret limit is <strong>sealed onchain</strong> before you
          speak, so every bluff is provably fair.
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
            <strong>Name a price</strong> with the quick buttons or by typing. A flaw or a cheaper stall backs it up; talk with no number never moves them.
          </li>
          <li>
            <strong>Read the tells</strong>: a merchant who looks firm is close to their limit; one who fidgets needs the sale.
          </li>
          <li>
            <strong>Call the bluff</strong> when they swear “not below 30”. Right, the price collapses. Wrong, it goes up, or they walk.
          </li>
          <li>
            <strong>Take the deal</strong> and see their real limit revealed.
          </li>
        </ul>
      ),
    },
    {
      art: "🪙",
      eyebrow: "The street economy",
      title: "Coins, cred and a stall of your own",
      body: (
        <ul>
          <li>
            A <strong>market day</strong> has a few haggles. Buy low, sell high, deliver goods for bounties.
          </li>
          <li>
            Deals and deliveries earn <strong>street cred</strong>. Levels unlock bigger jobs and a <strong>stall licence</strong>.
          </li>
          <li>
            Bid on <strong>cargo ships</strong>, buy <strong>tips</strong>, ride out <strong>street events</strong>. All settled on NEAR testnet.
          </li>
        </ul>
      ),
    },
    {
      art: "🧭",
      eyebrow: "Where to start",
      title: "Walk to Farrukh's stall",
      body: (
        <p>
          Use <strong>WASD</strong> to walk up to a stall on Canal Street and press <strong>F</strong> to haggle, or press <strong>J</strong> for a delivery job. Want a quick tour of the
          screen first?
        </p>
      ),
    },
  ],
  steps,
  help: {
    title: "Canal Street",
    elsewhere: { href: "/?classic", label: "🏜️ The desert bazaar", note: "is the original, simpler version: three stalls, no walking, and it runs in any browser." },
    controls: [
      [["W", "A", "S", "D"], "walk, drive or fly (arrows too)"],
      [["Space"], "jump, brake or climb"],
      [["Drag"], "look around"],
      [["1", "2", "3", "4"], "walk, cab, bike, helicopter"],
      [["F"], "haggle at a stall, deliver, work the docks, ask an informant"],
      [["J"], "delivery jobs board"],
      [["G"], "bid on the cargo at Pier 34"],
      [["T"], "trade at a price board"],
      [["M"], "map"],
      [["Esc"], "close a panel or leave a stall"],
      [["?"], "open this sheet"],
    ],
    rules: [
      <>
        Each merchant's <b>secret limit</b> is sealed on NEAR first; a rules engine, not the AI, decides prices.
      </>,
      <>
        <b>Catch a bluff</b> and the price drops; accuse an honest merchant and it rises and becomes final, or they walk away.
      </>,
      <>
        A few haggles per market day. Merchants remember lowballs and loyal customers.
      </>,
      <>
        Jobs have a countdown. Walking and cycling are free; a cab or helicopter fare comes out of the bounty.
      </>,
      <>
        <b>Street cred</b>: level 2 unlocks express jobs, level 3 uptown jobs and a stall licence.
      </>,
      <>
        Broke (under 20 coins)? Auntie Wu pays 40 for dock work at Pier 34, once a day.
      </>,
      <>
        During an <b>inspector raid</b>, haggle on Canal Street without a licence and the inspectors seize anything above 5 of each good.
      </>,
    ],
  },
  button: {
    className: "bz-card bz-help",
    content: (
      <>
        <b aria-hidden="true">?</b> How to play
      </>
    ),
  },
};

/** Add the "How to play" card to the HUD and show the welcome on a first visit. */
export function initGuide(hud: HTMLElement) {
  const host = document.createElement("div");
  host.className = "bz-guide-host";
  hud.appendChild(host);
  mountGuide(host, cfg);
}
