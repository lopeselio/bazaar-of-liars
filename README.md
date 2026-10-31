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

Day 1. The deterministic rules engine and secret commitments are done, with a terminal haggle and a balance simulator. There's no LLM, no contract and no web UI yet. The design is in [DESIGN.md](./DESIGN.md).

## Try it

You need Node 22 or later and pnpm.

1. Run `pnpm install`, then `pnpm test`. You should see 9 tests pass, including a 3,000-haggle fuzz test showing a merchant never deals below its secret floor.
2. Run `pnpm haggle`. A merchant prints a **commitment hash**, then an opening price. Type an offer (e.g. `40`), or claim a competitor's price (`40 saw 35`), or `take`. When the haggle ends, the secret floor and need are revealed and checked against the commitment, and you see `✓ fair play verified`.
3. Run `pnpm sim`. You should see a table of scripted bot strategies against each merchant: deal rate, walk-away rate, and how much each one overpaid above the hidden floor.

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
