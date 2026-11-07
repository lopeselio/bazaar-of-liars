# Bazaar of Liars — Design

> A haggling game against AI merchants who bluff. Each merchant has a secret: the lowest price it will
> accept and what it actually needs. You read the merchant and haggle in natural language. When the deal
> closes, the chain proves the merchant played fair: its secret was fixed before you started, every reply
> came from a verified model running in a TEE, and the deal respected its hidden floor.

**Primary track:** Games With Real Economies
**Secondary tracks:** Privacy & Private AI, Agent Economy

## The problem we're solving

When an NPC's AI can lie, players can't tell a clever bluff from the developer rigging the game. Hidden-information games such as poker or haggling need **proof of fair play**, and LLM-driven NPCs make that worse. We make an AI's bluffing verifiable, so it is fun rather than suspicious.

## The loop

| Cadence | What the player does |
|---|---|
| **Every 30 s** | Send an offer or a line ("I saw this rug for 40 at the next stall"). The merchant counters, bluffs or walks away. Tells leak through its mood and wording. |
| **Every 5 min** | Close or lose a deal. Afterwards the **reveal card** flips: the merchant's real floor, its need ("rent is due tonight") and a green ✓ badge for "fair play verified". You learn how much you left on the table. |
| **Every session** | Buy low from one merchant and sell high to another, since each has a different secret need. Climb the "Silver Tongue" leaderboard ranked by profit and by "left on the table". Merchants remember you: lowball one too often and it raises its prices for you. |

## Mechanics (v2)

- **Bluff-calling.** On a counter, a merchant sometimes claims a limit. Near its real limit it's usually the truth; far from it, bluffers usually lie (chance `0.3 + 1.2 × bluff`). The claim is seeded by `(secret.seed, round)`, so the verifier replays it. Calling a lie: the merchant gives up 65% of its remaining margin and can't bluff again. Calling the truth: mood drops sharply, the price rises 15% of the range toward the opening and becomes final, or the merchant walks.
- **Tells, not meters.** The rules engine's tell (relaxed / firm / nervous / irritated) drives per-merchant body language in the scene and the stage directions the model is told to use. An honest claim always comes with "firm". In the sim (200 sessions), `sharp` (calls unless firm) beats both `caller` (calls everything) and `splitter` (never calls) against every merchant: overpay 39/46/48% vs splitter 64/60/58%. Blind calling only pays against heavy bluffers (Farrukh 44%; Tobin 59%, no better than never calling).
- **Two sides, one engine.** A buying merchant is a selling merchant in a mirror: prices map `x ↦ 2C − x` around its ceiling C, so every rule, tell, claim and test applies in both directions. Fuzz tests check "never sells below the floor" and "never pays above the ceiling".
- **Trading.** Farrukh sells rugs and buys lamps, Zaria sells saffron and buys rugs, Tobin sells lamps and buys saffron. Sell floors are 0.75–1.05× base value and buy ceilings 0.95–1.35×, so trading pays if you read people well.
- **Memory.** `grudge` (lowballs, max 5) worsens the opening by 8% each; `loyalty` (deals, max 5) improves it by 2% each. Both live in the contract, go into the commitment, and are checked against the contract's own record at open.
- **Days and leaderboard.** Six haggles per market day, kept by the server per player (opening a haggle after sundown is refused until the player starts the next day), a sundown summary, and an onchain top 10 by peak purse (peaks only rise, so the list is exact).

## Agent economy on Canal Street (v3)

Track fit: Agent Economy ("give AI a wallet"), on top of Games and Privacy & Private AI.

- **Every trader on the street is an agent with its own NEAR account.** The merchants (`farrukh`, `zaria`, `tobin`), the wholesaler at the docks (`wu`), two rival traders (`ivy`, `rex`) and the runner (`lo`) are sub-accounts of the contract, e.g. `farrukh.v3.bazaar-liars.testnet`. Their coins and stock live in the contract, keyed by those accounts, so a player's purchase pays the merchant's own purse and comes off its own shelf.
- **How the agents hold their keys, and what they can't do.** Each agent account has exactly one key: a function-call key that may only call `authorize_spend` and `pay_agent` on the bazaar contract, with a 0.1 NEAR gas allowance. There is no full-access key, so an agent can't move NEAR or call anything else. The game server holds these keys (`~/.near-credentials` locally, the `AGENT_KEYS` secret when hosted); `packages/merchant/src/cli/setup-agents.ts` creates them.
- **The contract enforces each agent's policy, not the server:**
  - the server can't spend an agent's coins until the agent itself signs `authorize_spend(haggle_id, max)`, and the deal can't exceed that `max`;
  - no agent commits more than its `daily_cap` in a UTC day (merchants 400, traders 600, runner 50; reservations are released when a haggle settles for less or falls through);
  - a merchant never sells below what its stock cost it (its running cost basis), so its committed floor can't be a loss;
  - a merchant buying from a player pays out of coins escrowed from its own purse at open, so a broke merchant can't buy.
- **What the agents do on their own** (`apps/server/src/market.ts`, one replica at a time, every 40 s):
  - **Restock:** a merchant down to its last unit buys a lot of 4 from Auntie Wu at the docks. It's a real haggle: Wu commits a secret floor onchain, the merchant's buyer bot haggles under the same rules engine with a budget it signed for, and the contract settles it. Wu's prices rise as the day's lots sell.
  - **Hire:** after a restock, the merchant pays Little Lo, the runner, to haul the lot from Pier 34 (`pay_agent`, signed by the merchant).
  - **Use up:** merchants use the goods they bought, so they keep wanting more.
  - **Compete:** Ivy and Rex buy at one stall and sell to the merchant who wants that good. They drain the same stock players want, which pushes prices up. They're ranked on the same leaderboard as players.
- **Prices come from the books.** `packages/core/src/economy.ts` holds every rule in one readable file. A merchant's floor is its street value adjusted for scarcity (few left → dearer), recent demand (sales in the last 15 minutes → dearer) and noise, never below its cost basis. A buying merchant's ceiling depends on how many it already has and is capped by 60% of its purse. Each price comes with its reasons, which the haggle panel shows ("Only 1 left", "2 sold recently"); the numbers that would give away the limit stay hidden.
- **Going broke.** A merchant that can't afford a lot runs out and shutters its stall. Players can invest coins in it (`invest`), which funds its next restock.
- **Receipts.** Every action is an onchain event (`spend_authorized`, `haggle_opened`, `haggle_closed`, `agent_paid`, `invested`, `consumed`), and the street wire in the game links each line to its transaction.

## Delivery jobs across Manhattan (v3.1)

The 5-minute loop on Canal Street: take a job, buy the good, get it across town before the clock runs out.

- **Customers are agents.** Five businesses (a gallery at One World Trade Center, a tea room at the Flatiron, a deli in Times Square, a hotel at Grand Central, a dowager by Central Park) each have their own NEAR account. A customer posts an order with its own signature (`post_order`), which locks the bounty from its purse. Its income is capped onchain at 400 coins a day, and that income is the money its bounties come from.
- **Terms** (`packages/core/src/orders.ts`): the bounty covers the good's street value plus the trip. Express jobs pay more, but their window is too short to walk. One game minute is one real second.
- **Getting there is the choice.** Walking and cycling are free. Driving the cab or flying the helicopter is faster, and its fare goes to the cab company's account out of the bounty (`fulfil_order` splits it).
- **What the server checks.** Positions come from the player's browser, so the server checks what it can:
  - the player is within reach of the drop site;
  - the trip is physically possible, timed both from where the job was taken and from the player's last haggle on Canal Street.

  The travel mode, and so the fare, comes from that average speed, not from what the browser claims. A faster-than-possible arrival is refused.
- **Missed orders** expire after the deadline (anyone may call `expire_order`), and the bounty goes back to the customer.

## Street cred and daily streaks (v3.2)

The reason to come back tomorrow.

- **XP lives in the contract** (`cred_of`).
  - The contract awards what it can verify itself: +5 for a deal, +10 for a delivery (+5 more if express).
  - The server can add only what it alone sees, +4 per merchant caught bluffing, through `award_cred`. The contract caps that at 80 XP per player per day.
  - Agents earn no cred.
- **Streaks.** The first XP of a UTC day adds 5 × the streak (up to 7 days). Missing a day resets the streak to 1, and the best streak is kept.
- **Levels** follow `30 × (level − 1)²` XP: 0, 30, 120, 270, 480… Titles run from Newcomer to Bazaar Legend.
  - Level 2 unlocks express jobs.
  - Level 3 unlocks jobs from Times Square and Central Park.
  - Level 5 will unlock a stall licence.

  The server enforces the gates when a job is taken. The rules are in `packages/core/src/cred.ts`, with matching constants in the contract.

## Player stalls (v3.3)

The long-term hook: a stall that keeps trading while you're away.

- **Licence.** Four stall slots stand further along Canal Street. At 120 XP (level 3) a player can buy one licence for 150 coins, which is burned. The contract checks the XP, the slot and the one-stall-per-player rule.
- **Running it.** The owner moves goods from their purse onto the stall and sets each price (1–500). They can reprice or take goods back at any time.
- **Who buys** (`packages/core/src/stalls.ts`, run by `market.ts`):
  - Rival traders browse the stalls every tick. They buy anything priced under street value, more often the cheaper it is, to flip to a merchant.
  - A customer whose delivery order expired buys the good from a stall instead, if the listing is within its bounty.
- **Settlement.**
  - The buying agent signs `authorize_spend` with its own key, then the server calls `stall_sale`.
  - The contract checks the signed maximum and the agent's daily cap, moves the good to the agent and updates the agent's cost basis.
  - It pays the price, less a 10% street commission (burned), into the stall's till.
  - The server can't buy from a stall with an agent's coins on its own.
- **Coming back.** The owner collects the till with `collect_till`. The game shows what the stall sold since their last visit. Burned licence fees and commissions are public in `stats().burned`.

## Dock work: the way back from broke (v3.4)

A player can run out of coins and goods, which would end their game. Dock work fixes that without creating money.

- **Who:** only a player with fewer than 20 coins, once per UTC day.
- **Where:** Pier 34, at the west end of Canal Street. The server checks the reported position is within 45 m.
- **How it's paid:**
  - Auntie Wu, the wholesaler, signs `authorize_spend(wage_id, 40)` with her own key;
  - the server calls `pay_wages`, and the contract checks the player is broke and hasn't worked today;
  - the 40 coins move from Wu's purse, which is what merchants paid her for their lots.

  No coins are minted. Her daily cap (400) bounds how many shifts she can pay in a day.
- **In the city:** when your purse is nearly empty, a banner with a direction arrow and a green beacon lead to the docks.

## Goods are NEP-245 multi tokens (v3.5)

The Games track asks for items as NEP-245 multi tokens, with one contract holding every item type. The bazaar contract is that contract.

- **Tokens.** Each good is a token id: `rug`, `saffron`, `lamp`. The contract implements the core standard:
  - `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`, `mt_batch_supply` and `mt_token`;
  - `mt_transfer` and `mt_batch_transfer`, each needing exactly 1 yoctoNEAR;
  - `mt_transfer_call` and `mt_batch_transfer_call`, with refunds through `mt_resolve_transfer`.

  Approvals aren't supported, and the contract refuses them.
- **Every movement is a standard event.** Opening stock emits `mt_mint`, a merchant using a good up emits `mt_burn`, and every trade, escrow, delivery and stall sale emits `mt_transfer` (`standard: "nep245"`, version `1.0.0`). Explorers and indexers see every good's history.
- **Escrow is a real holder.** Goods in a haggle in progress, or stock on a player's stall, sit in the contract's own account. So at every moment the balances add up to `mt_supply`, and `pnpm check:goods` checks that from raw contract storage.
- **Who can transfer.** Any real NEAR account holding goods can call `mt_transfer`. Guest players have no keys yet, so their goods move only through the game (social login is next on the list). Agents' function-call keys can't attach the 1 yoctoNEAR, so agents can't transfer goods themselves either: their goods move only through settled haggles and sales.
- **Migration.** v3.5 was migrated in place. Before migrating, every haggle had to be closed and every stall empty, so all goods were in someone's balance. The supply passed to `migrate` was summed from the raw state, and it matched exactly afterwards.

## Signing in with NEAR Auth (v3.6)

Players start as guests and can sign in to get a real NEAR account, with no seed phrase and no wallet.

- **One popup.** The game logs in with NEAR Auth's Auth0 tenant (Google, email or passkey) and sends the server the ID token.
- **The server works out who that is** (`apps/server/src/auth.ts`):
  - it checks the token itself: an RS256 signature against the tenant's published keys (other algorithms are refused), plus issuer, audience, expiry and subject;
  - it asks NEAR's MPC contract which key NEAR Auth controls for that identity: `derived_public_key(path = "jwt#https://<tenant>/#<sub>", predecessor = fast-auth.testnet)`, the same key NEAR Auth signs with;
  - the player's account is the implicit NEAR account of that key.
- **Sessions.** The server issues an HMAC session for the account (30 days). Anything done as a NEAR account (haggles, jobs, stalls, dock work) needs that session; guests work as before.
- **Bringing guest progress.** `merge_player` moves a guest's coins, goods, street cred, merchants' memory and stall to the new account, once, and only into an account the game hasn't seen.
- **Limits.**
  - NEAR Auth's shared testnet client only lets sign-in return to `http://localhost:3000`, so sign-in works locally; the hosted demo stays guest-only until NEAR Auth allows its domain.
  - The game server still signs every game transaction: signing in establishes who you are. It doesn't (yet) have you sign game moves with your NEAR Auth key.
  - Your account can use `mt_transfer` once it holds a little NEAR for gas.

## Cargo ship auctions at Pier 34 (v3.7)

Every eight minutes or so a cargo ship docks at Pier 34 and its lot is auctioned with sealed bids. It gives the city a timed event to run to, a way to buy in bulk that isn't haggling, and a new source of goods: until now, every good came from opening stock.

- **The contract rolls the lot.** The server calls `ship_arrives` (at most once per 8 minutes). The contract picks the good, the quantity (4–10) and the reserve (half the street value) from the block's random seed, and mints the lot into its own escrow.
- **Sealed bids (commit-reveal).**
  - **Bidding (2½ min).** A bidder posts `sha256("bazaar-bid|auction|bidder|amount|salt")` and a deposit at least the bid.
  - **Who knows the bid.** A player's bid is hashed in their own browser. The salt stays in that browser, so not even the game server knows the amount until bidding closes.
  - **What the deposit shows.** A player's deposit is rounded up to the next 50; an agent's varies further, up to its headroom. The game hides other bidders' deposits until bidding closes, but they're public onchain, so a deposit is only an upper bound on a bid, never the bid.
  - **Reveal (75 s).** The browser reveals the bid by itself; the contract checks it against the hash and the deposit.
  - **Settlement.** Anyone can settle once the reveal closes. The highest bid at or above the reserve wins and pays what it bid. That payment is a harbour duty, burned, so auctions drain coins from the economy.
  - **Refunds.** Everyone else gets their deposit back. A bid that's never revealed loses 10% of its deposit, so nobody can bid and then decide whether to reveal after seeing the others.
- **Agents bid against you.** Auntie Wu bids on every lot (she resells lots to merchants), a merchant bids on its own good when its shelf is low, and the rival traders bid sometimes. Each agent signs `authorize_spend` for its deposit with its own key, within its daily cap. The server keeps the agents' salts until their reveal, as it does for merchants' haggle secrets.
- **XP.** Winning a lot is worth 10 XP.
- **In the city.** A ship's horn and a banner with a direction arrow announce the ship; a gold beam marks the pier. There, press **G** to open the bid panel. Bids show as 🔒 until they're revealed.
- **Releasing cap never fails.** Handing an agent back cap it reserved (at settlement, or a haggle that falls through) is never blocked by its cap, even if the owner lowered the cap meanwhile. Otherwise a lowered cap could freeze an auction for good.
- **No migration.** Auction state lives under its own raw storage keys (`x:…`), outside the root contract struct, so v3.7 deployed as a plain code upgrade.

## The rumour network (v3.8)

Informants around the city sell tips about the next few minutes. It's the Bazaar of *Liars*, so some of them lie, and the contract keeps score.

- **Where.** Madame Vex and Pigeon Pete are just off Canal Street. The Deacon is in Bryant Park and Lulu Lightfingers is under the Times Square billboards, so exploring the map pays. Walk up and press **F**.
- **What a tip is.** A claim about a merchant's stock at a check time 4 minutes away: "Tobin will have no saffron" (so he'll pay well for one) or "Zaria will have at least 2 rugs" (so she won't). The claim is chosen by rules (`packages/core/rumours.ts`). An honest informant says what the shelves suggest; a liar says something false right now. Each informant's honesty is secret.
- **Private AI.** The informant puts the claim in their own voice with the same TEE-hosted model on NEAR AI Cloud that voices the merchants. The model only words the tip; it can't change the facts.
- **Privacy, then proof.**
  - `sell_tip` puts only `sha256("bazaar-tip|tip|informant|merchant|good|le-or-ge|n|check_ms|salt")` onchain, and holds the price. Other players can't learn the tip, and the informant can't change it later.
  - At the check time, `resolve_tip` reveals the claim. The contract checks it against the hash, then against the merchant's real stock right then.
  - A true tip is paid (the price is burned). A lie is refunded.
  - Either way it goes on the informant's public record (`informants()`: sold, truths, lies, never revealed), which floats over their head in the city.
  - A tip the server never reveals can be expired by anyone after 15 minutes: refunded, and counted against the informant.
- **No spoiling a tip.** Trading with a merchant changes its stock, so a buyer could turn an honest tip into a "lie" and get a refund. The contract notes when each player last traded with each merchant. A tip whose buyer traded with that merchant before the check is **void**: the buyer pays, and the informant's record doesn't change.
- **Limits.** An honest informant can still be wrong: agents restock and trade in the meantime. The check runs when the server resolves the tip, within seconds of the check time, not at an exact block.

## Price boards and trade routes (v3.9)

The map is the market. Prices differ across town, so carrying goods pays, and the travel is the work.

- **Boards.**
  - **Auntie Wu's board at Pier 34 sells.** Her price is lower the more stock she has (0.78–1.08× street value). She keeps 4 of each good back for the merchants' restocks.
  - **The five customers post buy prices outside their doors.** These run from the Financial District up to the Dowager on 59th Street. A buyer pays more the further it is from Canal Street (up to +35%), and 8% less for each unit it has bought today. It stops once it's had enough.
- **Onchain.**
  - `buy_from_board` sells a player one unit at the posted price, never below what the stock cost the agent: the same no-loss rule as haggles.
  - `sell_to_board` is paid out of the buyer's own purse, at exactly the price the buyer signed for with `authorize_spend`, within its daily cap.
  - A buyer short of coins draws on its capped daily income first.
- **The best route.**
  - A HUD chip shows the best spread right now ("🧶 Pier 34 47 → Midtown East 84 +37"). Click it to be guided: a banner with an arrow and a green beam lead to where you buy, then to where you sell.
  - Boards stand beside the customers' delivery drop points, so a delivery run and a trade run can share a trip.
- **Why it's a loop.** Ships bring goods in at auction, Wu buys lots there and sells them on, players carry them uptown, and customers' income pays for them. Every leg is a signed, settled transaction.
- **Failure-safe.** One board trade per player runs at a time, at the price the player was shown or not at all. If a buyer signs but the sale then fails, `release_auth` gives its daily cap back.
- **Tips stay honest.** Trading at a merchant's board counts as trading with that merchant for the rumour network (a tip you hold about it becomes void).

## Street events (v3.10)

Every twelve minutes or so something happens on the street, and the contract decides what: `start_event` rolls it from the block's random seed. Each event lasts 4 minutes, and a banner at the top of the screen says what's on and for how long.

- **🎉 Festival (40%).** Buyers at the boards pay 25% more, and customers' delivery bounties rise by 25%.
- **📉 Shortage of one good (30%).** It costs 30% more at Wu's docks board, and buyers pay 40% more for it, so carrying that good uptown pays.
- **🚨 Inspector raid on Canal Street (30%).**
  - An unlicensed player who opens a haggle there loses whatever they carry above 5 of any good. The contract's `inspect` confiscates (burns) it, once per player per raid.
  - A stall licence exempts you. The contract checks it, so licences are worth more.
  - The banner warns you if you're over the limit, before you walk in.
  - Rival traders Ivy and Rex lie low until it's over.
- **Agents react.** Customers post richer orders at festivals, traders stop trading in raids, and board prices follow every event. The server reads the event from the contract, so all replicas agree.

## Property deeds (v3.11)

Stall licences used to be a row in the contract. Now each one is a deed: a NEP-171 NFT of the game contract, token id = the slot (`corner-1` … `corner-4`). There are only four, so a deed is scarce, and it's the one asset in the game a player can sell to another player.

- **Standards.** NEP-171 core (`nft_transfer` with 1 yoctoNEAR, `nft_transfer_call` with a receiver that can hand the deed back, `nft_token`), NEP-177 metadata (a parchment picture drawn by the contract as an SVG data URI, so nothing to host) and NEP-181 enumeration, so wallets and nearblocks show it. Every mint, transfer and burn emits the standard `nep171` event.
- **Lifecycle.** `buy_licence` mints the deed (still 150 coins burned and street cred level 3). `release_stall` burns it.
- **Deed market.** The owner lists the deed at a price (`list_deed`, up to 5000). Any player without a stall can `buy_deed` at exactly that price, so a price the buyer didn't see can't be charged. The seller gets the price less 5% (burned). No street cred is needed to buy: a deed is the shortcut past level 3, so a busy stall's deed is worth more than the licence fee. The panel suggests an ask from what the stall has earned.
- **What moves with it.** The slot only. When a deed changes hands by sale, wallet transfer or sign-in, the stall's stock and till go home with the old owner, and the new owner starts with an empty stall. Nobody holds two stalls: the contract refuses a transfer to an account that already has one, and refuses a sign-in merge that would stack two.
- **No migration.** Asks live under raw `x:deedask:` storage keys, and the deed itself is the existing stall record.

## Fair-play protocol (the core NEAR feature)

1. **Commit.** When a haggle opens, the server rolls the merchant's secret `{side, limit, need, seed, listPrice, grudge, loyalty}` and a salt. It posts `commitment = sha256("bazaar-v2|…|salt")` to the `bazaar` contract **before the player's first message**. The contract checks grudge and loyalty against its own memory, and escrows the player's good if the merchant is buying.
2. **Attest first.** Before the first completion, the server fetches the model's TEE attestation with a fresh nonce and verifies it: Intel TDX via dcap-qvl, NVIDIA via NRAS with JWKS-verified JWTs, and the signing key bound in the report data. If any check fails, the haggle refuses to start.
3. **Each player turn makes two signed NEAR AI Cloud completions.** We use a TEE-hosted model, non-streaming, with `x-no-aliasing`, which gives `signature_kind = provider_tee` signed over `MODEL:sha256(request):sha256(response)`.
   - **Read:** turns the player's words into a move (offer, competitor claim, accept, leave or talk). This request contains no secret.
   - **Speak:** voices the decision. The request carries `HAGGLE: <commitment>`, `NEED: <need>` and `DECISION: {action, tell, bluff}`. **It contains no numbers and never the floor.** The model writes `{PRICE}`, `{CLAIM}` and `{OFFER}` placeholders, and a deterministic `present()` function fills in the engine's numbers. Any other number the model writes, in digits or words, is blanked out. So the model can't state a wrong price or leak the floor, because it never knew it.
4. **Rules engine.** A deterministic engine (`packages/core/rules.ts`) makes every decision: counter, final, accept or walk. It never goes below `floor`. The LLM can't be talked into a bad deal because it doesn't make decisions (a prompt-injection attempt was tested live and the merchant stayed in character).
5. **Settle and reveal.** When the haggle ends, deal or not, the server calls `bazaar.close_haggle(haggle_id, secret, salt, deal_price?)`. The contract checks `sha256(preimage) == commitment` and, on a deal, `price >= floor`. Only then does it move coins and goods. The secret becomes public onchain either way, so a merchant's bluffs can be checked even when you walk away. If the server never reveals, anyone can call `expire_haggle` after `REVEAL_WINDOW_BLOCKS` (about 1 hour), and the haggle is counted publicly in `stats().unrevealed`. Ids are restricted to `[a-z0-9_-]`, so no `|` can shift preimage fields into each other. *(v3 is live on testnet at `v3.bazaar-liars.testnet`, with `bazaar-server.testnet` as the server; v1 and v2 are retired. Goods are NEP-245 multi tokens of this contract; see below.)* The verifier also checks that the commitment's block time is no later than the `created` timestamp inside the first TEE-signed reply, which proves the commitment was posted before the merchant spoke.
6. **Verify.** The player gets a **proof bundle** containing the commitment, the reveal, the attestation, and every signed request and response. `pnpm verify:haggle <bundle>` checks it with no API key:
   - the commitment matches the reveal;
   - the attestation's quote bindings hold;
   - every call is signed by an attested TEE key;
   - a **full rules replay** reproduces every decision;
   - every speech request was bound to this haggle and decision, and never showed the floor;
   - the displayed text is exactly `present(signed text)`;
   - the deal is at or above the floor.

**Privacy (a Privacy track requirement):** a live haggle's state, including its secret and salt, is held only until the haggle is revealed onchain, then deleted. The hosted demo keeps it in Azure Managed Redis, with persistence off and TLS on, so any server replica can serve the next turn and a restart doesn't drop a game. It's never written to disk. Locally it stays in the server's memory. The bundle goes to the player.

**What this proves:**
- the secret didn't change mid-haggle;
- every decision came from the rules engine, not the LLM;
- the deal respected the floor;
- every merchant line came from an attested TEE model, for this haggle and this decision;
- the model never saw the floor.

**What it doesn't prove, and the README must say so:** the game server *could* see the secret during the haggle. Closing that gap means running the server in a TEE (for example NEAR's Shade Agents or OutLayer). That's a stretch goal, not a promise.

## Hidden chain

Players never see wallets or gas:

- **Login:** players sign in by email or social account. The exact provider gets confirmed on day 1 from docs.near.org and the `near-dapp` skill.
- **Gas:** meta-transactions (NEP-366) through a relayer that pays the gas.
- **Player accounts:** each player is a sub-account, e.g. `p-xyz.bazaar.testnet`. Each merchant is one too, e.g. `m-rugseller.bazaar.testnet`.
- **Where the chain appears:** only in the ✓ badge on the reveal card.

## Architecture

```
apps/web        Three.js bazaar scene + chat haggle UI (Vite; primitives + canvas textures, no external assets)
apps/server     Haggle orchestrator: commit, NEAR AI Cloud calls, signature capture, settle;
                a shared store (Redis on Azure, memory locally) holds live haggles and market days
packages/core   rules.ts (accept/reject, mood, memory), secrets, commitment hashing — pure, tested
packages/verify Offline verifier for a haggle transcript bundle (also used by the UI badge)
contracts/      bazaar (Rust, near-sdk): commitments, settle-with-reveal, NEP-245 goods, coin balances
```

**Why web and not Unity:** the AI screeners and judges need to run the game with `pnpm i && pnpm dev`, or open a hosted link.

## Demo (90 s)

1. *"AI NPCs can lie. How do you know the game isn't cheating you?"*
2. Haggle with the rug seller. It claims "I can't go below 80."
3. Close at 65. The reveal card flips: its floor was 52 and "rent was due". The ✓ fair-play badge shows.
4. Click the badge. It shows the commitment transaction from before the haggle, the settle transaction, and the TEE signature for each line.
5. *"NEAR made the bluff provably fair: the secret was committed onchain, the replies were signed in a TEE, and the deal was checked by contract. And the player never touched a wallet."*

## 14-day plan

| Days | Deliverable |
|---|---|
| 1–2 | `packages/core`: secrets, commitment, rules engine, mood and memory. A CLI haggle against scripted bot players, with no LLM. Is it fun? |
| 3–4 | NEAR AI Cloud integration: capture each completion with its signature and attestation, plus the offline `verify` package. |
| 5–7 | `bazaar` contract: commit, settle-with-reveal, NEP-245 goods. Tests, including a settle with a wrong salt or below the floor. Deploy to testnet. |
| 8–10 | Web: one bazaar scene, 3 merchants, chat panel, reveal card, verify modal. |
| 11 | Email/social login and relayer, so no wallet ever appears. |
| 12 | Leaderboard and merchant memory. Polish the tells. |
| 13 | Hosted deploy (kept up through 2026-11-25). Write the README "do X, see Y" steps and go through `SUBMITTING.md`. |
| 14 | Demo video and X post (@NEARProtocol #NEARHackathon), then submit with plenty of time left before 23:59 UTC. |

## Open questions to settle on day 1

- Which model is TEE-hosted and fast enough for chat (for example `zai-org/GLM-5.1-FP8` is a reasoning model and may be slow). Check docs.near.ai/cloud/models.
- Which login and relayer path is live on testnet.
- Whether hackathon credits exist for NEAR AI Cloud. Ask in the builders Telegram.
