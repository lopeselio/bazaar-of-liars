/**
 * End-to-end session + bundle verification against a fake TEE
 * (a local wallet that signs exactly like NEAR AI Cloud's provider_tee).
 */
import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { MERCHANTS, type PlayerMemory, type Side } from "@bazaar/core";
import { sha256Hex, type ChatSignature } from "@bazaar/verify";
import { HaggleSession, verifyBundle, type ChainReader, type Ledger, type OnchainHaggle, type TxInfo, parseMove, present, quickMove, wordsToNumber, type Attestor, type ChatRequest, type LlmClient, type ProofBundle } from "../src/index.js";

const MODEL = "test/model";
const tee = Wallet.createRandom();

/** Scripted model: classifies "N" / "take" / "bye", and echoes the decision price in speech. */
function fakeLlm(): LlmClient {
  const sigs = new Map<string, ChatSignature>();
  let n = 0;
  return {
    async complete(req: ChatRequest) {
      const requestBody = JSON.stringify(req);
      const isExtraction = req.response_format?.type === "json_object";
      const user = req.messages[req.messages.length - 1].content;
      let content: string;
      if (isExtraction) {
        const num = user.match(/\d+/);
        content = JSON.stringify(
          /take/.test(user) ? { intent: "accept", price: null, competitorPrice: null }
          : /bye/.test(user) ? { intent: "leave", price: null, competitorPrice: null }
          : num ? { intent: "offer", price: Number(num[0]), competitorPrice: null }
          : { intent: "talk", price: null, competitorPrice: null },
        );
      } else {
        const d = JSON.parse(req.messages[0].content.match(/DECISION: (.*)/)![1]);
        content = d.action === "walk" ? "*waves you off* Go." : "*shrugs* {PRICE}, friend.";
      }
      const chatId = `chat-${n++}`;
      const responseBody = JSON.stringify({ id: chatId, created: Math.floor(Date.now() / 1000), choices: [{ message: { content } }] });
      const text = `${MODEL}:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
      sigs.set(chatId, { text, signature: await tee.signMessage(text), signing_address: tee.address, signing_algo: "ecdsa", signature_kind: "provider_tee" });
      return { call: { requestBody, responseBody, chatId, signature: null }, content };
    },
    async signature(chatId) {
      return sigs.get(chatId) ?? null;
    },
  };
}

const fakeAttestor: Attestor = {
  async attest(model) {
    return {
      nonce: "00".repeat(32),
      report: { model_attestations: [] },
      verification: { model, nonce: "00".repeat(32), verifiedAt: new Date().toISOString(), ok: true, trustedSigners: [tee.address.toLowerCase()], candidates: [] },
    };
  },
};

async function playScript(lines: string[], seed = 1234, side: Side = "sell", merchant = MERCHANTS[2], memory?: PlayerMemory) {
  const s = new HaggleSession(fakeLlm(), fakeAttestor, MODEL, merchant, seed, undefined, side, memory);
  await s.open();
  for (const l of lines) if (s.status === "open") await s.turn(l);
  return s.bundle();
}
const opts = { trustedSignersOverride: [tee.address] };

describe("haggle session + proof bundle", () => {
  it("a full haggle verifies end to end", async () => {
    const b = await playScript(["hello there", "10", "15", "take"]);
    expect(b.outcome.status).toBe("deal");
    const failed = (await verifyBundle(b, opts)).filter((c) => !c.ok);
    expect(failed).toEqual([]);
  });

  it("talking doesn't move the price", async () => {
    const b = await playScript(["nice rug", "what a day", "bye"]);
    expect(b.turns[0].decision!.price).toBe(b.turns[1].decision!.price);
    expect(b.outcome.status).toBe("left");
  });

  const tamper = async (mutate: (b: ProofBundle) => void) => {
    const b = await playScript(["10", "15", "take"]);
    mutate(b);
    return (await verifyBundle(b, opts)).filter((c) => !c.ok).map((c) => c.id);
  };

  it("detects a changed secret floor", async () => {
    expect(await tamper((b) => (b.reveal.secret.floor -= 1))).toContain("commitment");
  });

  it("detects an edited merchant line", async () => {
    expect(await tamper((b) => (b.turns[0].display = "Fine, 1 coin."))).toContain("t0.sp.display");
  });

  it("detects a decision the rules engine didn't make", async () => {
    expect(await tamper((b) => (b.turns[1].decision!.price -= 3))).toContain("t1.decision");
  });

  it("detects a forged model response", async () => {
    expect(
      await tamper((b) => {
        b.turns[0].speech!.responseBody = b.turns[0].speech!.responseBody.replace("friend", "pal");
      }),
    ).toContain("t0.sp.sig");
  });

  it("detects signatures from an unattested key", async () => {
    const b = await playScript(["10", "take"]);
    const failed = (await verifyBundle(b, { trustedSignersOverride: [Wallet.createRandom().address] })).filter((c) => !c.ok);
    expect(failed.some((c) => c.id.endsWith(".sig"))).toBe(true);
  });
});

describe("parsing and presentation", () => {
  it("falls back to the player's number when model JSON is broken", () => {
    expect(parseMove("not json", "how about 42?")).toEqual({ kind: "offer", price: 42 });
    expect(parseMove('{"intent":"offer","price":null}', "hmm")).toEqual({ kind: "talk" });
  });

  it("only the engine's numbers (and the player's offer) reach the player", () => {
    const d = { action: "counter" as const, price: 30, tell: "relaxed" as const, statedFloor: 25 };
    expect(present("{OFFER}? My floor is 21. {PRICE}, no less than {CLAIM}.", d, 12)).toBe("12? My floor is …. 30, no less than 25.");
    expect(present("Deal for sixty-two, friend!", d)).toBe("Deal for …, friend! [30 coins] Not a coin below 25.");
    expect(present("Hmm, no.", d)).toBe("Hmm, no. [30 coins] Not a coin below 25.");
    // The player offered exactly the claimed limit: echoing their offer isn't stating the claim.
    expect(present("{OFFER}? You wound me. {PRICE}. It is the lowest I could ever go.", d, 25)).toBe("25? You wound me. 30. It is the lowest I could ever go. Not a coin below 25.");
    // Bundles recorded before this rule rendered it without the claim; the verifier accepts both.
    expect(present("{OFFER}? You wound me. {PRICE}. It is the lowest I could ever go.", d, 25, "sell", true)).toBe("25? You wound me. 30. It is the lowest I could ever go.");
    // A claim the model wrote out itself isn't repeated.
    expect(present("{OFFER}? {PRICE}, and not below {CLAIM}.", d, 25)).toBe("25? 30, and not below 25.");
  });

  it("a {CLAIM} outside a bluffing counter is blanked", () => {
    const final = { action: "final" as const, price: 30, tell: "firm" as const, statedFloor: 25 };
    expect(present("{PRICE}. Not below {CLAIM}.", final)).toBe("30. Not below ….");
  });
});

describe("the floor never reaches the model", () => {
  it("speech prompts across a whole haggle omit the floor", async () => {
    const b = await playScript(["10", "12", "hi", "14", "take"]);
    for (const t of b.turns) {
      if (!t.speech) continue;
      const sys = JSON.parse(t.speech.requestBody).messages[0].content as string;
      const lines = sys.split("\n").filter((l) => !l.startsWith("Personality:") && !l.startsWith("HAGGLE:"));
      expect(lines.join("\n")).not.toMatch(new RegExp(`(?<!\\d)(?<!\\d\\.)${b.reveal.secret.floor}(?!\\d)(?!\\.\\d)`));
    }
  });
});

describe("local fast path + number words", () => {
  it("parses unambiguous messages locally", () => {
    expect(quickMove("55")).toEqual({ kind: "offer", price: 55 });
    expect(quickMove("That rug looks faded. I'll give you 55.")).toEqual({ kind: "offer", price: 55 });
    expect(quickMove("take")).toEqual({ kind: "accept" });
    expect(quickMove("Deal!")).toEqual({ kind: "accept" });
    expect(quickMove("I'm walking away")).toEqual({ kind: "leave" });
  });

  it("defers ambiguous messages to the model", () => {
    expect(quickMove("The stall by the well sells it for 40")).toBeNull();
    expect(quickMove("I would never pay 80")).toBeNull();
    expect(quickMove("50 now, or 60 tomorrow")).toBeNull();
    expect(quickMove("what a lovely pattern")).toBeNull();
  });

  it("converts number words", () => {
    expect(wordsToNumber("eighty-four")).toBe(84);
    expect(wordsToNumber("a hundred and five")).toBe(105);
    expect(wordsToNumber("Fifty five")).toBe(55);
  });

  it("keeps spelled-out numbers only when they are the offer or the engine's price", () => {
    const d = { action: "counter" as const, price: 84, tell: "relaxed" as const };
    expect(present("Fifty-five? No. Eighty-four.", d, 55)).toBe("55? No. 84.");
    expect(present("Seventy, not a coin less.", d, 55)).toBe("…, not a coin less. [84 coins]");
  });

  it("a fast-path haggle still verifies", async () => {
    const b = await playScript(["I'll give you 10", "12", "take"]);
    expect(b.turns.every((t) => t.extraction === null)).toBe(true);
    expect((await verifyBundle(b, opts)).filter((c) => !c.ok)).toEqual([]);
  });
});

describe("claims and competitor prices", () => {
  it("frames a bare {CLAIM} as a minimum", () => {
    const d = { action: "counter" as const, price: 66, tell: "irritated" as const, statedFloor: 64 };
    expect(present("You insult me! {CLAIM}. {PRICE}.", d)).toBe("You insult me! Not below 64. 66.");
    expect(present("Not below {CLAIM}, so {PRICE}.", d)).toBe("Not below 64, so 66.");
  });

  it("a complaint is not a goodbye, even if the model says leave", () => {
    const leave = '{"intent":"leave","price":null,"competitorPrice":null}';
    expect(parseMove(leave, "it's too expensive for a Rug")).toEqual({ kind: "talk" });
    expect(parseMove(leave, "forget it, I'm going elsewhere")).toEqual({ kind: "leave" });
    expect(parseMove(leave, "bye")).toEqual({ kind: "leave" });
  });

  it("a competitor claim without an offer counts as an offer at that price", () => {
    expect(parseMove('{"intent":"talk","price":null,"competitorPrice":60}', "they sell it for 60")).toEqual({
      kind: "offer",
      price: 60,
      competitorPrice: 60,
    });
  });
});

describe("walk-away lines", () => {
  it("never show a price", () => {
    const walk = { action: "walk" as const, price: 58, tell: "irritated" as const };
    expect(present("*snorts* {OFFER}? 58. Take it or leave it. Begone, {PRICE}!", walk, 32)).toBe("*snorts* 32? …. Take it or leave it. Begone, …!");
  });
});

/** In-memory stand-in for the bazaar contract + RPC. */
function fakeChain(opts: { openDelayMs?: number } = {}) {
  const haggles = new Map<string, OnchainHaggle>();
  const txs = new Map<string, TxInfo>();
  let n = 0;
  const ledger: Ledger = {
    network: "testnet",
    contractId: "bazaar.test",
    serverId: "server.test",
    async open(a) {
      haggles.set(a.haggleId, { player: a.player, side: a.side, grudge: a.grudge, loyalty: a.loyalty, merchant_id: a.merchantId, good_id: a.goodId, commitment: a.commitment, opened_block: 1, status: "open", price: null, secret: null, salt: null });
      const tx = `tx${n++}`;
      txs.set(tx, {
        blockTimeMs: Date.now() + (opts.openDelayMs ?? 0),
        signerId: "server.test",
        receiverId: "bazaar.test",
        calls: [{ method: "open_haggle", args: { haggle_id: a.haggleId, commitment: a.commitment, player: a.player } }],
        ok: true,
      });
      return tx;
    },
    async close(a) {
      const h = haggles.get(a.haggleId)!;
      Object.assign(h, { status: a.dealPrice === null ? "no_deal" : "deal", price: a.dealPrice, secret: { ...a.secret }, salt: a.salt });
      const tx = `tx${n++}`;
      txs.set(tx, { blockTimeMs: Date.now(), signerId: "server.test", receiverId: "bazaar.test", calls: [{ method: "close_haggle", args: { haggle_id: a.haggleId } }], ok: true });
      return tx;
    },
  };
  const reader: ChainReader = {
    async getHaggle(_n, _c, id) {
      return haggles.get(id) ?? null;
    },
    async txInfo(_n, hash) {
      return txs.get(hash)!;
    },
  };
  return { ledger, reader, haggles, txs };
}

async function playOnchain(lines: string[], chain = fakeChain()) {
  const s = new HaggleSession(fakeLlm(), fakeAttestor, MODEL, MERCHANTS[2], 1234, { ledger: chain.ledger, player: "guest.test" });
  await s.open();
  for (const l of lines) if (s.status === "open") await s.turn(l);
  await s.close();
  return { b: await s.bundle(), chain };
}

describe("onchain commit + settle", () => {
  it("an onchain haggle verifies against the contract", async () => {
    const { b, chain } = await playOnchain(["10", "15", "take"]);
    expect(b.chain?.closeTx).toBeTruthy();
    const checks = await verifyBundle(b, { ...opts, chain: chain.reader });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining(["chain.commit", "chain.order", "chain.settle", "chain.reveal"]));
  });

  it("a walk-away is still revealed onchain", async () => {
    const { b, chain } = await playOnchain(["bye"]);
    expect(chain.haggles.get(b.haggleId)!.status).toBe("no_deal");
    expect((await verifyBundle(b, { ...opts, chain: chain.reader })).filter((c) => !c.ok)).toEqual([]);
  });

  it("detects a commitment posted after the merchant started talking", async () => {
    const { b, chain } = await playOnchain(["10", "take"], fakeChain({ openDelayMs: 60_000 }));
    expect((await verifyBundle(b, { ...opts, chain: chain.reader })).filter((c) => !c.ok).map((c) => c.id)).toContain("chain.order");
  });

  it("detects an openTx that isn't this haggle's own open_haggle", async () => {
    // Point the bundle at an earlier, real server-to-contract transaction: another haggle's open.
    const chain = fakeChain();
    const other = await playOnchain(["10", "take"], chain);
    const { b } = await playOnchain(["10", "take"], chain);
    const failed = (bundle: ProofBundle) => verifyBundle(bundle, { ...opts, chain: chain.reader }).then((cs) => cs.filter((c) => !c.ok).map((c) => c.id));
    expect(await failed(b)).toEqual([]);
    expect(await failed({ ...b, chain: { ...b.chain!, openTx: other.b.chain!.openTx } })).toContain("chain.opentx");
    // ...or at this haggle's own close.
    expect(await failed({ ...b, chain: { ...b.chain!, openTx: b.chain!.closeTx! } })).toContain("chain.opentx");
  });

  it("detects an open_haggle transaction that failed", async () => {
    const { b, chain } = await playOnchain(["10", "take"]);
    chain.txs.get(b.chain!.openTx)!.ok = false;
    expect((await verifyBundle(b, { ...opts, chain: chain.reader })).filter((c) => !c.ok).map((c) => c.id)).toContain("chain.opentx");
  });

  it("detects a bundle whose reveal differs from the onchain one", async () => {
    const { b, chain } = await playOnchain(["10", "take"]);
    chain.haggles.get(b.haggleId)!.secret!.floor -= 1;
    expect((await verifyBundle(b, { ...opts, chain: chain.reader })).filter((c) => !c.ok).map((c) => c.id)).toContain("chain.reveal");
  });
});

describe("budget", () => {
  it("refuses an unaffordable offer without recording it", async () => {
    const s = new HaggleSession(fakeLlm(), fakeAttestor, MODEL, MERCHANTS[2], 1234);
    await s.open();
    const r = await s.turn("I'll give you 50", 20);
    expect(r.refused).toEqual({ reason: "budget", budget: 20, price: 50 });
    await s.turn("take", 1000);
    const b = await s.bundle();
    expect(b.turns).toHaveLength(1);
    expect((await verifyBundle(b, opts)).filter((c) => !c.ok)).toEqual([]);
  });
});

describe("bluff-calling, selling to merchants, memory", () => {
  it("'you're lying' is parsed locally as a call", () => {
    expect(quickMove("You're lying!")).toEqual({ kind: "call" });
    expect(quickMove("liar")).toEqual({ kind: "call" });
    expect(quickMove("I'm not bluffing")).toBeNull();
  });

  it("a haggle with a called bluff verifies end to end", async () => {
    // Farrukh bluffs a lot; find a seed where a claim appears, then call it.
    for (let seed = 1; seed < 400; seed++) {
      const s = new HaggleSession(fakeLlm(), fakeAttestor, MODEL, MERCHANTS[0], seed);
      await s.open();
      for (let i = 0; i < 6 && s.status === "open" && s.claim === undefined; i++) await s.turn(String(30 + i * 4));
      if (s.claim === undefined || s.status !== "open") continue;
      const r = await s.turn("You're lying!");
      expect(r.decision?.call).toMatch(/caught|honest/);
      if (s.status === "open") await s.turn("take");
      const b = await s.bundle();
      expect((await verifyBundle(b, opts)).filter((c) => !c.ok)).toEqual([]);
      // The model is told THAT it makes a claim, never whether the claim is true.
      for (const t of b.turns) {
        const line = (JSON.parse(t.speech?.requestBody ?? '{"messages":[{"content":""}]}').messages[0].content as string).split("\n").find((l) => l.startsWith("DECISION:"));
        if (line) expect(Object.keys(JSON.parse(line.slice(10))).sort()).toEqual(expect.arrayContaining(["action", "claim", "tell"]));
        if (line) expect(line).not.toMatch(/truth|lie|floor|ceiling/);
      }
      return;
    }
    throw new Error("no claim found");
  });

  it("selling a good to a merchant verifies end to end, and never pays above the ceiling", async () => {
    const b = await playScript(["I want 60 for it", "55", "take"], 99, "buy", MERCHANTS[1]);
    expect(b.reveal.secret.side).toBe("buy");
    if (b.outcome.dealPrice !== null) expect(b.outcome.dealPrice).toBeLessThanOrEqual(b.reveal.secret.floor);
    expect((await verifyBundle(b, opts)).filter((c) => !c.ok)).toEqual([]);
  });

  it("memory is committed and replayed", async () => {
    const b = await playScript(["10", "take"], 1234, "sell", MERCHANTS[2], { lowballs: 2, deals: 1 });
    expect(b.reveal.secret.grudge).toBe(2);
    expect(b.reveal.secret.loyalty).toBe(1);
    expect((await verifyBundle(b, opts)).filter((c) => !c.ok)).toEqual([]);
    const tampered = structuredClone(b);
    tampered.reveal.secret.grudge = 0;
    expect((await verifyBundle(tampered, opts)).filter((c) => !c.ok).map((c) => c.id)).toContain("commitment");
  });

  it("frames a buying merchant's claim as a maximum", () => {
    const d = { action: "counter" as const, price: 40, tell: "relaxed" as const, statedFloor: 45 };
    expect(present("{PRICE}. {CLAIM}.", d, undefined, "buy")).toBe("40. Not above 45.");
    expect(present("I can pay no more than {CLAIM}.", d, undefined, "buy")).toBe("I can pay no more than 45. [40 coins]");
  });
});

describe("claim presentation", () => {
  const d = { action: "counter" as const, price: 86, tell: "firm" as const, statedFloor: 57 };
  it("doesn't double-frame a claim the model already framed", () => {
    expect(present("{PRICE}. {CLAIM} is my absolute limit.", d)).toBe("86. 57 is my absolute limit.");
    expect(present("{CLAIM} is the lowest I go. {PRICE}.", d)).toBe("57 is the lowest I go. 86.");
  });
  it("always shows a claim the player could call", () => {
    expect(present("*sighs* {PRICE}.", d)).toBe("*sighs* 86. Not a coin below 57.");
    expect(present("*sighs* {PRICE}.", { ...d, price: 40, statedFloor: 74 }, undefined, "buy")).toBe("*sighs* 40. I can't pay more than 74.");
  });
});

describe("snapshot + restore (shared store across replicas)", () => {
  it("a haggle resumed from JSON after every turn still settles and verifies", async () => {
    const llm = fakeLlm();
    const chain = fakeChain();
    const first = new HaggleSession(llm, fakeAttestor, MODEL, MERCHANTS[2], 1234, { ledger: chain.ledger, player: "guest.test" });
    await first.open();
    // Each turn runs on a "different replica": only the JSON survives, in-flight signature fetches don't.
    let snap = JSON.stringify(first.snapshot());
    for (const l of ["10", "15", "take"]) {
      const s = HaggleSession.restore(JSON.parse(snap), llm, fakeAttestor, chain.ledger);
      if (s.status !== "open") break;
      await s.turn(l);
      snap = JSON.stringify(s.snapshot());
    }
    const last = HaggleSession.restore(JSON.parse(snap), llm, fakeAttestor, chain.ledger);
    expect(last.id).toBe(first.id);
    expect(last.status).toBe("deal");
    await last.close();
    const b = await last.bundle();
    expect(b.turns.every((t) => [t.extraction, t.speech].every((c) => !c || c.signature))).toBe(true);
    expect((await verifyBundle(b, { ...opts, chain: chain.reader })).filter((c) => !c.ok)).toEqual([]);
  });

  it("refuses to restore an onchain haggle without its ledger", async () => {
    const chain = fakeChain();
    const s = new HaggleSession(fakeLlm(), fakeAttestor, MODEL, MERCHANTS[2], 1, { ledger: chain.ledger, player: "guest.test" });
    await s.open();
    expect(() => HaggleSession.restore(s.snapshot(), fakeLlm(), fakeAttestor)).toThrow(/ledger/);
  });
});
