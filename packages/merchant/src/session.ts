/**
 * One haggle with an LLM-voiced merchant.
 *   open()  → roll + commit secret, attest the model (preflight, before any completion)
 *   turn()  → [signed] read the player → rules engine decides → [signed] merchant speaks
 *   bundle()→ everything a third party needs to replay and verify the haggle
 *
 * Privacy: the session holds state in memory only. Nothing is written server-side;
 * the proof bundle is handed to the player.
 */
import { randomUUID } from "node:crypto";
import {
  GOODS,
  acceptAsk,
  commit,
  holdReply,
  leftOnTable,
  mulberry32,
  newSalt,
  openHaggle,
  respond,
  rollSecret,
  type HaggleState,
  type Merchant,
  type MerchantReply,
} from "@bazaar/core";
import { newNonce, verifyModelReport, fetchModelAttestation, type ModelVerification, type AttestationReport, type ChatSignature } from "@bazaar/verify";
import type { ChatRequest, SignedCall } from "./nearai.js";
import { extractionRequest, parseMove, present, speechRequest, toPlayerMove, type Line, type Move } from "./prompts.js";
import type { ProofBundle, TurnRecord } from "./bundle.js";

export interface LlmClient {
  complete(req: ChatRequest): Promise<{ call: SignedCall; content: string }>;
  signature(chatId: string, model: string): Promise<ChatSignature | null>;
}

export interface Attestor {
  attest(model: string): Promise<{ nonce: string; report: AttestationReport; verification: ModelVerification }>;
}

export const nearAiAttestor = (apiKey: string): Attestor => ({
  async attest(model) {
    const nonce = newNonce();
    const report = await fetchModelAttestation(model, nonce, apiKey);
    return { nonce, report, verification: await verifyModelReport(report, model, nonce) };
  },
});

export interface TurnResult {
  move: Move;
  decision: MerchantReply | null;
  text: string;
  status: HaggleState["status"] | "left";
}

export class HaggleSession {
  readonly id = randomUUID();
  private state!: HaggleState;
  private salt = newSalt();
  private commitment = "";
  private attestation!: Awaited<ReturnType<Attestor["attest"]>>;
  private turns: TurnRecord[] = [];
  private lines: Line[] = [];
  private pendingSigs: Promise<void>[] = [];
  private left = false;
  readonly openedAt = new Date().toISOString();

  constructor(
    private llm: LlmClient,
    private attestor: Attestor,
    readonly model: string,
    readonly merchant: Merchant,
    private seed: number,
  ) {}

  get good() {
    return GOODS[this.merchant.goodId];
  }
  get ask() {
    return this.state.ask;
  }
  get status(): TurnResult["status"] {
    return this.left ? "left" : this.state.status;
  }

  /** Returns the commitment (to post onchain) and the opening line. */
  async open(): Promise<{ commitment: string; openingAsk: number; verification: ModelVerification }> {
    const secret = rollSecret(mulberry32(this.seed), this.merchant, this.good);
    this.state = openHaggle(secret, this.merchant.personality);
    this.commitment = commit(secret, this.salt);
    // Preflight: attest BEFORE the first completion, so the evidence can't be swapped afterwards.
    this.attestation = await this.attestor.attest(this.model);
    if (!this.attestation.verification.ok) throw new Error("model TEE attestation failed — refusing to haggle");
    return { commitment: this.commitment, openingAsk: this.state.ask, verification: this.attestation.verification };
  }

  private sign(call: SignedCall) {
    this.pendingSigs.push(
      this.llm.signature(call.chatId, this.model).then((s) => {
        call.signature = s;
      }),
    );
  }

  async turn(playerText: string): Promise<TurnResult> {
    if (this.status !== "open") throw new Error(`haggle is ${this.status}`);
    const askBefore = this.state.ask;

    // 1. Understand the player (no secret in this request).
    const ex = await this.llm.complete(extractionRequest(this.model, playerText, askBefore));
    this.sign(ex.call);
    const move = parseMove(ex.content, playerText);

    // 2. The rules engine decides. The LLM has no say.
    let decision: MerchantReply | null;
    if (move.kind === "leave") {
      this.left = true;
      decision = null;
    } else if (move.kind === "accept") decision = acceptAsk(this.state);
    else if (move.kind === "offer") decision = respond(this.state, toPlayerMove(move));
    else decision = holdReply(this.state);

    this.lines.push({ speaker: "player", text: playerText });
    const record: TurnRecord = { playerText, askBefore, extraction: ex.call, move, decision, speech: null, display: "" };

    // 3. The merchant voices the decision (secret + decision are in the signed request).
    if (decision) {
      const offer = move.kind === "offer" ? move.price : undefined;
      const sp = await this.llm.complete(
        speechRequest(this.model, this.merchant, this.good, this.commitment, this.state.secret, decision, this.lines, this.turns.length, offer !== undefined),
      );
      this.sign(sp.call);
      record.speech = sp.call;
      record.display = present(sp.content, decision, offer);
      this.lines.push({ speaker: "merchant", text: sp.content });
    }
    this.turns.push(record);
    return { move, decision, text: record.display, status: this.status };
  }

  /** Reveal + proof. Call after the haggle ends. */
  async bundle(): Promise<ProofBundle> {
    await Promise.all(this.pendingSigs);
    return {
      version: "bazaar-proof-v1",
      haggleId: this.id,
      openedAt: this.openedAt,
      model: this.model,
      merchant: this.merchant,
      commitment: this.commitment,
      reveal: { secret: this.state.secret, salt: this.salt },
      attestation: this.attestation,
      turns: this.turns,
      outcome: {
        status: this.status,
        dealPrice: this.state.dealPrice ?? null,
        leftOnTable: leftOnTable(this.state) ?? null,
      },
    };
  }
}
