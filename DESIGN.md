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
- **Days and leaderboard.** Six haggles per market day (a client-side session goal), a sundown summary, and an onchain top 10 by peak purse (peaks only rise, so the list is exact).

## Fair-play protocol (the core NEAR feature)

1. **Commit.** When a haggle opens, the server rolls the merchant's secret `{side, limit, need, seed, listPrice, grudge, loyalty}` and a salt. It posts `commitment = sha256("bazaar-v2|…|salt")` to the `bazaar` contract **before the player's first message**. The contract checks grudge and loyalty against its own memory, and escrows the player's good if the merchant is buying.
2. **Attest first.** Before the first completion, the server fetches the model's TEE attestation with a fresh nonce and verifies it: Intel TDX via dcap-qvl, NVIDIA via NRAS with JWKS-verified JWTs, and the signing key bound in the report data. If any check fails, the haggle refuses to start.
3. **Each player turn makes two signed NEAR AI Cloud completions.** We use a TEE-hosted model, non-streaming, with `x-no-aliasing`, which gives `signature_kind = provider_tee` signed over `MODEL:sha256(request):sha256(response)`.
   - **Read:** turns the player's words into a move (offer, competitor claim, accept, leave or talk). This request contains no secret.
   - **Speak:** voices the decision. The request carries `HAGGLE: <commitment>`, `NEED: <need>` and `DECISION: {action, tell, bluff}`. **It contains no numbers and never the floor.** The model writes `{PRICE}`, `{CLAIM}` and `{OFFER}` placeholders, and a deterministic `present()` function fills in the engine's numbers. Any other number the model writes, in digits or words, is blanked out. So the model can't state a wrong price or leak the floor, because it never knew it.
4. **Rules engine.** A deterministic engine (`packages/core/rules.ts`) makes every decision: counter, final, accept or walk. It never goes below `floor`. The LLM can't be talked into a bad deal because it doesn't make decisions (a prompt-injection attempt was tested live and the merchant stayed in character).
5. **Settle and reveal.** When the haggle ends, deal or not, the server calls `bazaar.close_haggle(haggle_id, secret, salt, deal_price?)`. The contract checks `sha256(preimage) == commitment` and, on a deal, `price >= floor`. Only then does it move coins and goods. The secret becomes public onchain either way, so a merchant's bluffs can be checked even when you walk away. If the server never reveals, anyone can call `expire_haggle` after `REVEAL_WINDOW_BLOCKS` (about 1 hour), and the haggle is counted publicly in `stats().unrevealed`. Ids are restricted to `[a-z0-9_-]`, so no `|` can shift preimage fields into each other. *(v2 is live on testnet at `v2.bazaar-liars.testnet`, with `bazaar-server.testnet` as the server; v1 at `bazaar-liars.testnet` is retired. Goods are an internal ledger for now, and NEP-245 is a stretch goal.)* The verifier also checks that the commitment's block time is no later than the `created` timestamp inside the first TEE-signed reply, which proves the commitment was posted before the merchant spoke.
6. **Verify.** The player gets a **proof bundle** containing the commitment, the reveal, the attestation, and every signed request and response. `pnpm verify:haggle <bundle>` checks it with no API key:
   - the commitment matches the reveal;
   - the attestation's quote bindings hold;
   - every call is signed by an attested TEE key;
   - a **full rules replay** reproduces every decision;
   - every speech request was bound to this haggle and decision, and never showed the floor;
   - the displayed text is exactly `present(signed text)`;
   - the deal is at or above the floor.

**Privacy (a Privacy track requirement):** the server keeps haggle state in memory only and stores nothing after a haggle ends. The bundle goes to the player.

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
apps/server     Haggle orchestrator: commit, NEAR AI Cloud calls, signature capture, settle
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
