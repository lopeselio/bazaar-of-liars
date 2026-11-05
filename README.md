# Bazaar of Liars

A haggling game against AI merchants who bluff, where the chain proves every bluff was fair.
Built at NEAR HACKATHON (1–14 Nov 2026). Tracks: Games With Real Economies, Privacy & Private AI, Agent Economy.

## What it is

Each merchant holds a secret: the lowest price it will accept and what it really needs. You haggle in plain language. When the deal closes:

- the merchant's secret was **committed onchain before the haggle began**;
- every merchant reply was produced by a **TEE-hosted model on NEAR AI Cloud** and signed;
- a **NEAR contract** settles the trade only if the revealed secret matches the commitment and the price respects the floor.

Players never see a wallet or pay gas.

## Status

Day 1. Done so far:
- the deterministic rules engine and secret commitments, with a terminal haggle and a balance simulator;
- the NEAR AI Cloud attestation verifier;
- LLM-voiced merchants with TEE-signed replies, plus a proof bundle and an independent verifier, all working live;
- the `bazaar` NEAR contract (commit, reveal-and-settle, public expiry of unrevealed haggles), unit-tested but not yet deployed.

There's no web UI yet, and the game doesn't call the contract yet. The design is in [DESIGN.md](./DESIGN.md).

## Try it

You need Node 22 or later and pnpm.

1. Run `pnpm install`, then `pnpm test`. You should see 9 core tests pass (42 across the repo), including a 3,000-haggle fuzz test showing a merchant never deals below its secret floor.
2. Run `pnpm haggle`. A merchant prints a **commitment hash**, then an opening price. Type an offer (e.g. `40`), or claim a competitor's price (`40 saw 35`), or `take`. When the haggle ends, the secret floor and need are revealed and checked against the commitment, and you see `✓ fair play verified`.
3. Run `pnpm sim`. You should see a table of scripted bot strategies against each merchant: deal rate, walk-away rate, and how much each one overpaid above the hidden floor.
4. Copy `.env.example` to `.env` and set `NEARAI_API_KEY` (from cloud.near.ai). Then run `pnpm verify:model`. It fetches a TEE attestation for the merchant model with a fresh random nonce and prints a **Verified panel** with these checks:
   - **Intel TDX:** the quote's signature chains to Intel (checked with dcap-qvl against Intel's PCS), the TEE isn't in debug mode, and the container manifest matches `mr_config_id`.
   - **Signing key:** the key that will sign merchant replies, plus our nonce, is bound into the TDX report data.
   - **NVIDIA GPUs:** NVIDIA's NRAS verdict and each GPU's report, with every JWT verified against NVIDIA's JWKS.

   You should see `✓ VERIFIED — trusted signers: 0x…`. Attestation is free and needs no credits. Use `--offline` to skip the Intel and NVIDIA network calls, or `--json out.json` to save the full bundle.
5. **No API key needed:** run `pnpm verify:haggle examples/sample-haggle.json`. This replays a real recorded haggle with Tobin of the Lamps and checks 46 things, including:
   - the revealed secret matches the commitment;
   - every model call is TEE-signed by an attested key;
   - a full rules-engine replay reproduces every decision;
   - the model was never told the floor;
   - the deal is at or above the floor.

   You should see `✓ FAIR PLAY VERIFIED`. Edit any number in the file and run it again to see the checks fail.
6. **Needs credits:** run `pnpm haggle:llm` (or `pnpm haggle:llm -- zaria`) and haggle in plain English, e.g. `I'll give you 30, the stall by the well sells it for 40`. Type `take` to accept or `leave` to walk away. Replies take about 0.5–2 s. At the end you see the real floor and need, `✓ Fair play verified`, and a proof bundle written to `haggles/`.

7. **Needs Rust:** run `pnpm test:contract`. You should see 15 contract tests pass, including:
   - the contract's commitment hash matches the TypeScript one byte for byte, and the sample haggle from step 5 verifies onchain;
   - a deal below the committed floor is rejected;
   - a reveal with a changed floor or wrong salt is rejected;
   - only the game server can open or close a haggle;
   - if the server never reveals, anyone can expire the haggle after about an hour, and it's counted publicly in `stats().unrevealed`.

## Repo layout (planned)

```
apps/web         Three.js bazaar + chat haggle UI
apps/server      haggle orchestrator (commit → NEAR AI Cloud → settle)
packages/core    rules engine, secrets, commitments
packages/verify  offline fair-play verifier
contracts/       bazaar contract (Rust, near-sdk)
```

## Honest limits

The game server can see a merchant's secret during a haggle. The design guarantees that the secret can't *change* and that the deal *respects* it. It doesn't guarantee the secret stays hidden from the server's operator. See DESIGN.md, "What it doesn't prove".

## License

MIT
