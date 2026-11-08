# Submitting Bazaar of Liars

Everything for the NEAR HACKATHON submission that can be public. Rules: https://nearhackathon.com/HACKATHON.md (re-read before submitting). Deadline **2026-11-14 23:59 UTC**; judging from 2026-11-16; keep the hosted demo up to at least 2026-11-25.

Personal details (name, email, payout account) never go in this repo: the submission payload is built at submit time and not committed.

## Checklist

| Item | Status |
|---|---|
| Public repo with LICENSE (MIT) | ✓ github.com/lopeselio/bazaar-of-liars |
| README with "do X, see Y" steps a judge can run, including a no-key path | ✓ (dry-run from a fresh clone on 2026-11-07) |
| Hosted demo | ✓ https://bazaar-liars.delightfulwave-c85acb1b.northeurope.azurecontainerapps.io/ |
| Libraries and templates listed (Q-005) | ✓ README, "Built with" |
| Other project disclosed (Q-015) | ✓ this README names Realm Ledger; check that Realm Ledger's README names this one |
| Demo video (90 s, see below) | to record |
| X post with the video, @NEARProtocol and #NEARHackathon | to post (draft below) |
| Mainnet NEAR account for the payout | the team creates it |
| Submit once via the API or https://nearhackathon.com/#apply | after the X post is up |

The team decides these at submit time: project name, team lead, contact email, team size, tracks, payout account, repo link, demo post link, the description below, and consent to the contact notice.

## Tracks

Chosen: **`games`** (primary), **`privacy`**, **`agents`**, **`nfts`**, **`swarms`**.

| Track | Why it fits | Hints it uses |
|---|---|---|
| Games With Real Economies | NPC merchants with wallets, a player-owned stall and deed market, an economy the agents run between visits; players never see a wallet or gas | Agent NPCs, social login (NEAR Auth), NEP-245 goods |
| Privacy & Private AI | Every merchant line is produced by a TEE model on NEAR AI Cloud, attested (Intel TDX + NVIDIA) and signed; the model never sees the merchant's real limit, only the engine's decision and the merchant's mood; when a haggle ends the server deletes it from its store (Redis without persistence), the secret is revealed onchain for anyone to check, and the player keeps the proof | Private AI, TEE, NEAR AI Cloud |
| Agent Economy | Agents with their own sub-accounts earn, spend, hire runners, bid in auctions and sell tips; each key can only authorize spends within an onchain daily cap | Agent commerce, function-call keys, Chain Signatures |
| NFTs That Do Something | A deed is the stall: transferring it moves the business, the seller's stock and till go home | NEP-171, Chain Signatures |
| AI Swarms | Thirteen agents, each a NEAR sub-account with its own purse and capped key, coordinate through markets nobody scripts: merchants restock from the wholesaler and hire a runner, rival traders buy low and sell high, the wholesaler, merchants and traders bid against each other (and players) in sealed-bid cargo auctions, and customers post delivery bounties; alongside them, informants sell tips the contract checks. Prices and stock emerge from what they do | Multi-agent systems, sub-accounts, sealed bidding |

## Description (the `idea` field, 1688 of 2000 characters)

```
Haggling games have a trust problem: when an AI merchant says "I can't go below 65", you can't tell a bluff from a rigged game. Bazaar of Liars is a trading game against AI merchants who bluff, where the chain proves every bluff was fair.

Before each haggle the server commits a hash of the merchant's secret (its real limit and need) to our NEAR contract. Every merchant line comes from a TEE-hosted model on NEAR AI Cloud, attested (Intel TDX + NVIDIA) and signed, and the model never sees the limit: a deterministic rules engine decides every move. When the haggle ends, the contract settles only if the revealed secret matches the commitment and the price respects it. Anyone can re-check a downloaded proof with one command, no key needed.

On Canal Street (a walkable New York), every trader is an AI agent with its own NEAR sub-account and a function-call key that can only authorize spends within an onchain daily cap. Merchants restock from a wholesaler, pay runners, bid in sealed-bid cargo auctions, and informants sell tips the contract later checks against real stock (liars refund). Customers post delivery bounties; players carry goods across the city, run trade routes between price boards, earn onchain street cred, and buy stall licences that are NEP-171 deeds, tradable in a deed market and certifiable on Ethereum through NEAR Chain Signatures. Goods are NEP-245 multi tokens. Players sign in with NEAR Auth (Google or email, MPC-held key) or play as guests; the server relays every transaction, so players never see a wallet or pay gas.

Testnet contract: v3.bazaar-liars.testnet. Hosted demo, 144 TypeScript and 132 contract tests, and a README of do-X-see-Y steps.
```

## Evidence: NEAR features and a transaction for each

| Feature | Where | Proof |
|---|---|---|
| Commit, reveal and settle a haggle | `contracts/bazaar`, `open_haggle` / `close_haggle` | Sample haggle, played on the earlier `v2.bazaar-liars.testnet` (same flow as today's `v3`): [commit](https://testnet.nearblocks.io/txns/CE2w2jenWqxxkb8Vagohe9GjK9E9upqYJXoypRdpnBoq), [reveal and settle](https://testnet.nearblocks.io/txns/Dmd6wvubYuzmVfrB6m91S9bhhiodcJuTSHXPoZCwUE3p); `pnpm verify:haggle examples/sample-haggle.json` |
| NEAR AI Cloud TEE (attestation and signed replies) | `packages/verify`, `packages/merchant` | `pnpm verify:model` (needs a key), and the attestation checks in every proof bundle |
| Agent sub-accounts with function-call keys and daily caps | `authorize_spend`, `pay_agent`, `post_order` | [rex authorizes a spend](https://testnet.nearblocks.io/txns/Ahqq76i9rnJnLNkM9sogZtJxeSvLfmsNCaehjope1TiM), [a customer posts a bounty](https://testnet.nearblocks.io/txns/65P5peFBVz3xzqpNPm85Mqss3LdAzgUTAsXhow6T8kpS) |
| Delivery bounty paid onchain | `fulfil_order` | [delivery](https://testnet.nearblocks.io/txns/3gct6uUPw6RQY8FMCvuArum2zCExdRLLUx3i5nfDBnnX) |
| Sealed-bid cargo auction | `ship_arrives`, `commit_bid`, `reveal_bid`, `settle_auction` | [ship arrives](https://testnet.nearblocks.io/txns/8idyGzATAWV32yAemfj997yfEwF2bYZhjT8JxfJ3WUJ1), [settled](https://testnet.nearblocks.io/txns/5UR4SgQp2GRq53aaPvacZMo4t3S2GXXFzceMHD394HdD) |
| Street events rolled by the contract | `start_event` | [event](https://testnet.nearblocks.io/txns/2QrBdAZCNNZy6YmXMWrF7nHS43eod5MuByxkPPcFH2W2) |
| NEP-245 goods | `mt_*` | `pnpm check:goods` (balances add up to `mt_supply`) |
| NEP-171 deeds and the deed market | `nft_*`, `buy_licence`, `buy_deed` | [deed minted](https://testnet.nearblocks.io/txns/HQQTmVhXCL4qhZEqFZGiRWGCTrLppV7UEvAdEc16HUtF), [deed sold](https://testnet.nearblocks.io/txns/DV1ziN37eu3E4D7Entrow2j8CzZ45WHGQKoBzZ5ivGxr), [the deed on nearblocks](https://testnet.nearblocks.io/nft-token/v3.bazaar-liars.testnet/corner-1) |
| Chain Signatures (MPC signs for Ethereum) | `certify_deed` → `v1.signer-prod.testnet` | [certification](https://testnet.nearblocks.io/txns/GReHCPKNjxnFmNiL9z51DZ3Zn9tdehRrCyd3VrPoaUVf); `pnpm verify:deed corner-1` |
| NEAR Auth sign-in (MPC-derived account) | `apps/server/src/auth.ts` | README step 17 (local only until NEAR Auth allows the hosted domain) |

## Two minutes for a judge

1. Open the hosted demo, click **Tobin of the Lamps**, then **Buy the Brass Lamp**. You'll see the enclave check, then **🔒 Secret sealed on NEAR** linking to the commitment.
2. Offer a low price, then call his bluff when he claims a limit. Take the deal, and the reveal card shows his real floor, every claim he made and whether it was true, with **✓ Fair play verified**.
3. Click **Download proof**, then run `pnpm install && pnpm verify:haggle <file>` (no key). All checks should pass.
4. Open `/city/` (WebGPU browser). Press **F** at a stall: the merchant is an AI agent with its own account and purse, and the **Canal St wire** shows the agents trading on their own, each line a transaction.
5. Run `pnpm verify:deed corner-1`: a deed certificate signed by NEAR's MPC network checks against an Ethereum address, using chain reads only.

## X post (draft; the team posts it)

> Ever haggled with someone who swore "I can't go lower"? In Bazaar of Liars the AI merchants bluff, and NEAR proves every bluff was fair: the secret is committed onchain before you speak, every line is signed inside a TEE on NEAR AI Cloud, and the contract checks the reveal.
>
> Built at NEAR HACKATHON. Play: <hosted demo link> · Code: github.com/lopeselio/bazaar-of-liars
>
> Can you catch a liar? @NEARProtocol #NEARHackathon @NearBuilders

## Demo video (about 90 seconds)

1. **0–10 s, the problem.** A merchant says "not below 28". Caption: *is it a bluff, or a rigged game?*
2. **10–35 s, one full haggle.** Open Tobin. Show the enclave check and the 🔒 commitment link, offer low, see the 💡 hint, then **Call the bluff** and *Caught!* as the price collapses.
3. **35–50 s, the proof.** The reveal card (real floor, claims marked true or false), then the evidence drawer, then a terminal running `pnpm verify:haggle` with all checks green.
4. **50–75 s, the agent economy.** Canal Street: the wire scrolling with transactions, a stall's agent account, and a delivery or a sealed bid at Pier 34.
5. **75–90 s, ownership.** A stall deed on nearblocks, **Certify on Ethereum**, then `pnpm verify:deed`. End card: demo link, repo, *built at NEAR HACKATHON*.

Record against the hosted demo during a quiet hour: the free RPC answers "too many requests" under load (the server fails over to other endpoints, but a retake is cheaper than a stall).
