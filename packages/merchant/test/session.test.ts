/**
 * End-to-end session + bundle verification against a fake TEE
 * (a local wallet that signs exactly like NEAR AI Cloud's provider_tee).
 */
import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { MERCHANTS } from "@bazaar/core";
import { sha256Hex, type ChatSignature } from "@bazaar/verify";
import { HaggleSession, verifyBundle, parseMove, present, quickMove, wordsToNumber, type Attestor, type ChatRequest, type LlmClient, type ProofBundle } from "../src/index.js";

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
      const responseBody = JSON.stringify({ id: chatId, choices: [{ message: { content } }] });
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

async function playScript(lines: string[], seed = 1234) {
  const s = new HaggleSession(fakeLlm(), fakeAttestor, MODEL, MERCHANTS[2], seed);
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
    expect(present("Deal for sixty-two, friend!", d)).toBe("Deal for …, friend! [30 coins]");
    expect(present("Hmm, no.", d)).toBe("Hmm, no. [30 coins]");
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
