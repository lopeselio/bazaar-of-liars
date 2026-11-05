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
  callBluff,
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
  type PlayerMemory,
  type Side,
} from "@bazaar/core";
import { newNonce, verifyModelReport, fetchModelAttestation, type ModelVerification, type AttestationReport, type ChatSignature } from "@bazaar/verify";
import type { ChatRequest, SignedCall } from "./nearai.js";
import { extractionRequest, parseMove, present, quickMove, speechRequest, toPlayerMove, type Line, type Move } from "./prompts.js";
import type { ProofBundle, TurnRecord } from "./bundle.js";
import type { ChainRecord, Ledger } from "./chain.js";

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
  /** Set when the turn was refused before the merchant heard it (nothing recorded, nothing changed). */
  refused?: { reason: "budget"; budget: number; price: number };
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
  private chain: ChainRecord | null = null;

  constructor(
    private llm: LlmClient,
    private attestor: Attestor,
    readonly model: string,
    readonly merchant: Merchant,
    private seed: number,
    /** Optional: post the commitment and the reveal to the bazaar contract. */
    private onchain?: { ledger: Ledger; player: string },
    /** "sell": the merchant sells to the player. "buy": the merchant buys from the player. */
    readonly side: Side = "sell",
    /** What this merchant remembers about the player (must match the contract's record). */
    private memory: PlayerMemory = { lowballs: 0, deals: 0 },
  ) {}

  get good() {
    return GOODS[this.side === "sell" ? this.merchant.goodId : this.merchant.buysGoodId];
  }
  /** The merchant's live claimed limit, if any: what the player could call a bluff. */
  get claim(): number | undefined {
    return this.state.status === "open" ? this.state.claim : undefined;
  }
  get grudge() {
    return this.state.secret.grudge;
  }
  get loyalty() {
    return this.state.secret.loyalty;
  }
  get ask() {
    return this.state.ask;
  }
  get status(): TurnResult["status"] {
    return this.left ? "left" : this.state.status;
  }

  /** Returns the commitment (to post onchain) and the opening line. */
  async open(): Promise<{ commitment: string; openingAsk: number; verification: ModelVerification; openTx: string | null }> {
    const secret = rollSecret(mulberry32(this.seed), this.merchant, this.good, this.side, this.memory);
    this.state = openHaggle(secret, this.merchant.personality);
    this.commitment = commit(secret, this.salt);
    // Preflight: attest BEFORE the first completion, so the evidence can't be swapped afterwards.
    // Intel PCS / NVIDIA NRAS are network calls and occasionally flake, so one retry with a
    // fresh nonce. Each attempt is a full verification; a failure is never ignored.
    for (let attempt = 1; ; attempt++) {
      try {
        this.attestation = await this.attestor.attest(this.model);
      } catch (e) {
        if (attempt >= 2) throw new Error(`model TEE attestation failed — refusing to haggle (${(e as Error).message})`);
        continue;
      }
      if (this.attestation.verification.ok) break;
      if (attempt >= 2) {
        const failed = this.attestation.verification.candidates.flatMap((c) => c.checks.filter((x) => !x.ok && x.required).map((x) => x.label));
        throw new Error(`model TEE attestation failed — refusing to haggle (${[...new Set(failed)].slice(0, 3).join("; ")})`);
      }
    }
    // Commit onchain BEFORE the player's first message. If this fails, the haggle doesn't start.
    if (this.onchain) {
      const { ledger, player } = this.onchain;
      const openTx = await ledger.open({
        haggleId: this.id,
        player,
        side: this.side,
        merchantId: this.merchant.id,
        goodId: this.good.id,
        grudge: secret.grudge,
        loyalty: secret.loyalty,
        commitment: this.commitment,
      });
      this.chain = { network: ledger.network, contractId: ledger.contractId, serverId: ledger.serverId, player, openTx, closeTx: null };
    }
    return { commitment: this.commitment, openingAsk: this.state.ask, verification: this.attestation.verification, openTx: this.chain?.openTx ?? null };
  }

  private sign(call: SignedCall) {
    this.pendingSigs.push(
      this.llm.signature(call.chatId, this.model).then((s) => {
        call.signature = s;
      }),
    );
  }

  /**
   * @param budget coins the player holds. An offer or acceptance above it is refused before the
   *   rules engine sees it, so the merchant can never agree a deal the contract would reject.
   */
  async turn(playerText: string, budget?: number): Promise<TurnResult> {
    if (this.status !== "open") throw new Error(`haggle is ${this.status}`);
    const askBefore = this.state.ask;

    // 1. Understand the player: locally if unambiguous, else via the model (no secret in that request).
    let move = quickMove(playerText);
    let extraction: SignedCall | null = null;
    if (!move) {
      const ex = await this.llm.complete(extractionRequest(this.model, playerText, askBefore, this.side));
      this.sign(ex.call);
      extraction = ex.call;
      move = parseMove(ex.content, playerText);
    }

    // Only a player who is buying spends coins.
    if (budget !== undefined && this.side === "sell") {
      const price = move.kind === "offer" ? move.price : move.kind === "accept" ? askBefore : undefined;
      if (price !== undefined && price > budget) {
        return { move, decision: null, text: "", status: this.status, refused: { reason: "budget", budget, price } };
      }
    }

    // 2. The rules engine decides. The LLM has no say.
    let decision: MerchantReply | null;
    if (move.kind === "leave") {
      this.left = true;
      decision = null;
    } else if (move.kind === "accept") decision = acceptAsk(this.state);
    else if (move.kind === "call") decision = callBluff(this.state);
    else if (move.kind === "offer") decision = respond(this.state, toPlayerMove(move));
    else decision = holdReply(this.state);

    this.lines.push({ speaker: "player", text: playerText });
    const record: TurnRecord = { playerText, askBefore, extraction, move, decision, speech: null, display: "" };

    // 3. The merchant voices the decision (secret + decision are in the signed request).
    if (decision) {
      const offer = move.kind === "offer" ? move.price : undefined;
      const sp = await this.llm.complete(
        speechRequest(this.model, this.merchant, this.good, this.commitment, this.state.secret, decision, this.lines, this.turns.length, offer !== undefined),
      );
      this.sign(sp.call);
      record.speech = sp.call;
      record.display = present(sp.content, decision, offer, this.side);
      this.lines.push({ speaker: "merchant", text: sp.content });
    }
    this.turns.push(record);
    return { move, decision, text: record.display, status: this.status };
  }

  /**
   * Reveal onchain (deal or not). The contract re-checks the commitment and the floor
   * and only then moves coins and the good. Call once, after the haggle ends.
   */
  async close(): Promise<ChainRecord | null> {
    if (!this.onchain || !this.chain || this.chain.closeTx || this.chain.closeError) return this.chain;
    try {
      this.chain.closeTx = await this.onchain.ledger.close({
        haggleId: this.id,
        secret: this.state.secret,
        salt: this.salt,
        dealPrice: this.state.status === "deal" ? this.state.dealPrice! : null,
        lowballed: this.state.lowballed,
      });
    } catch (e) {
      this.chain.closeError = (e as Error).message.slice(0, 300);
    }
    return this.chain;
  }

  /** Reveal + proof. Call after the haggle ends (and after close(), if onchain). */
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
      ...(this.chain ? { chain: this.chain } : {}),
      outcome: {
        status: this.status,
        dealPrice: this.state.dealPrice ?? null,
        leftOnTable: leftOnTable(this.state) ?? null,
      },
    };
  }
}
