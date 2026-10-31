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

## Fair-play protocol (the core NEAR feature)

1. **Commit.** When a haggle opens, the server rolls the merchant's secret `{floor, need, personality_seed}` and a salt. It posts `commitment = sha256(secret || salt)` to the `bazaar` contract **before the player's first message**.
2. **Haggle.** Every merchant reply is a NEAR AI Cloud completion (`cloud-api.near.ai/v1`, OpenAI-compatible) from a TEE-hosted model. The request body contains the committed secret. For each reply we store:
   - `request_hash` and `response_hash` (SHA-256 of the exact bytes);
   - the `/v1/signature/{chat_id}` result, `signature_kind = provider_tee`, which signs `MODEL_ID:request_hash:response_hash`;
   - a model attestation report fetched with a nonce **before** the completion.
3. **Rules engine.** The LLM only *proposes* a counteroffer and writes the dialogue. A deterministic engine (`packages/core/rules.ts`) decides accept or reject, and it never accepts below `floor`. The LLM cannot be talked into a bad deal, because it doesn't control acceptance.
4. **Settle and reveal.** On accept, the server calls `bazaar.settle(deal, secret, salt)`. The contract checks `sha256(secret || salt) == commitment` and `price >= floor`, then moves the goods (NEP-245) and the coin. The secret becomes public onchain.
5. **Verify.** Anyone can recheck a finished haggle: the reveal card links to the commitment transaction, the settle transaction and a transcript bundle that a script (`pnpm verify <haggle-id>`) checks offline.

**What this proves:** the secret didn't change mid-haggle, the deal respected it, and every merchant line came from the model given *that* secret (the request hash includes it).

**What it doesn't prove, and the README must say so:** the game server *could* see the secret during the haggle. Closing that gap means running the server in a TEE (for example NEAR's Shade Agents or OutLayer). That's a stretch goal, not a promise.

## Hidden chain

Players never see wallets or gas:

- **Login:** players sign in by email or social account. The exact provider gets confirmed on day 1 from docs.near.org and the `near-dapp` skill.
- **Gas:** meta-transactions (NEP-366) through a relayer that pays the gas.
- **Player accounts:** each player is a sub-account, e.g. `p-xyz.bazaar.testnet`. Each merchant is one too, e.g. `m-rugseller.bazaar.testnet`.
- **Where the chain appears:** only in the ✓ badge on the reveal card.

## Architecture

```
apps/web        Three.js bazaar scene + chat haggle UI (threejs-game-skills scaffold)
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
