/**
 * Proof bundle + independent verifier.
 * Given only the bundle, anyone can check that:
 *   - the revealed secret matches the commitment made before the haggle,
 *   - the model ran in an attested TEE (attested before the first reply),
 *   - every model call is signed by that TEE over the exact request/response bytes,
 *   - the rules engine — not the LLM — produced every decision (full deterministic replay),
 *   - every speech request carried the committed secret and that decision,
 *   - what the player saw is a deterministic transform of the signed text,
 *   - the deal respected the secret floor.
 */
import {
  acceptAsk,
  holdReply,
  openHaggle,
  respond,
  verifyCommitment,
  type Merchant,
  type MerchantReply,
  type MerchantSecret,
} from "@bazaar/core";
import {
  verifyChatSignature,
  verifyModelReport,
  type AttestationReport,
  type Check,
  type ModelVerification,
} from "@bazaar/verify";
import type { SignedCall } from "./nearai.js";
import { decisionLine, haggleLine, needLine, parseMove, present, quickMove, toPlayerMove, type Move } from "./prompts.js";

export interface TurnRecord {
  playerText: string;
  askBefore: number;
  /** Null when the move was parsed locally (quickMove) — the verifier re-derives it. */
  extraction: SignedCall | null;
  move: Move;
  decision: MerchantReply | null;
  speech: SignedCall | null;
  display: string;
}

export interface ProofBundle {
  version: "bazaar-proof-v1";
  haggleId: string;
  openedAt: string;
  model: string;
  merchant: Merchant;
  commitment: string;
  reveal: { secret: MerchantSecret; salt: string };
  attestation: { nonce: string; report: AttestationReport; verification: ModelVerification };
  turns: TurnRecord[];
  outcome: { status: string; dealPrice: number | null; leftOnTable: number | null };
}

export interface BundleVerifyOptions {
  /** Re-run Intel PCS + NVIDIA NRAS checks (network). Default: offline quote checks only. */
  online?: boolean;
  /** Test hook: supply trusted signers instead of re-verifying the attestation report. */
  trustedSignersOverride?: string[];
}

const contentOf = (responseBody: string) => JSON.parse(responseBody).choices?.[0]?.message?.content ?? "";
const systemOf = (requestBody: string): string => JSON.parse(requestBody).messages?.[0]?.content ?? "";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** True iff the floor appears as a number in our instructions (personality scales excluded). */
function promptShowsFloor(system: string, floor: number): boolean {
  const re = new RegExp(`(?<!\\d)(?<!\\d\\.)${floor}(?!\\d)(?!\\.\\d)`);
  return system.split("\n").some((l) => !l.startsWith("Personality:") && !l.startsWith("HAGGLE:") && re.test(l));
}

export async function verifyBundle(b: ProofBundle, opts: BundleVerifyOptions = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, label: string, ok: boolean, detail?: string) => checks.push({ id, label, ok, required: true, detail });
  const { secret, salt } = b.reveal;

  // 1. Commitment
  add("commitment", "Revealed secret matches the commitment made before the haggle", verifyCommitment(b.commitment, secret, salt));

  // 2. Attestation
  let trusted: string[];
  if (opts.trustedSignersOverride) trusted = opts.trustedSignersOverride.map((s) => s.toLowerCase());
  else {
    const v = await verifyModelReport(b.attestation.report, b.model, b.attestation.nonce, { offline: !opts.online });
    add("attestation", `Model TEE attestation verifies${opts.online ? " (Intel + NVIDIA re-checked)" : " (quote bindings, offline)"}`, v.ok);
    trusted = v.trustedSigners;
  }

  // 3. Replay every turn through the rules engine.
  const state = openHaggle(secret, b.merchant.personality);
  let left = false;
  b.turns.forEach((t, i) => {
    const n = `Turn ${i + 1}`;
    const sigOk = (call: SignedCall | null) => {
      if (!call?.signature) return false;
      return verifyChatSignature(call.signature, { model: b.model, requestBody: call.requestBody, responseBody: call.responseBody, trustedSigners: trusted }).every((c) => c.ok);
    };

    add(`t${i}.ex.ask`, `${n}: recorded ask matches replay`, t.askBefore === state.ask);
    let move: Move;
    if (t.extraction) {
      add(`t${i}.ex.sig`, `${n}: reading of the player's words is TEE-signed`, sigOk(t.extraction));
      add(`t${i}.ex.nosecret`, `${n}: that request contained no secret`, !t.extraction.requestBody.includes(needLine(secret)));
      move = parseMove(contentOf(t.extraction.responseBody), t.playerText);
    } else {
      const local = quickMove(t.playerText);
      add(`t${i}.ex.local`, `${n}: unambiguous message parsed locally (re-derived)`, local !== null);
      move = local ?? { kind: "talk" };
    }
    add(`t${i}.move`, `${n}: move follows from the player's words`, same(move, t.move));

    let decision: MerchantReply | null = null;
    try {
      if (move.kind === "leave") left = true;
      else if (move.kind === "accept") decision = acceptAsk(state);
      else if (move.kind === "offer") decision = respond(state, toPlayerMove(move));
      else decision = holdReply(state);
    } catch (e) {
      add(`t${i}.replay`, `${n}: rules replay`, false, (e as Error).message);
      return;
    }
    add(`t${i}.decision`, `${n}: decision was made by the rules engine (replay matches)`, same(decision, t.decision));

    if (decision) {
      if (decision.price < secret.floor) add(`t${i}.floor`, `${n}: price is at or above the floor`, false);
      const sys = t.speech ? systemOf(t.speech.requestBody) : "";
      add(`t${i}.sp.sig`, `${n}: merchant's line is TEE-signed`, sigOk(t.speech));
      add(`t${i}.sp.bound`, `${n}: the signed request was for this haggle, its committed need and this decision`, sys.includes(haggleLine(b.commitment)) && sys.includes(needLine(secret)) && sys.includes(decisionLine(decision)));
      add(`t${i}.sp.nofloor`, `${n}: the model was never told the floor`, !promptShowsFloor(sys, secret.floor));
      const offer = move.kind === "offer" ? move.price : undefined;
      add(`t${i}.sp.display`, `${n}: shown text = signed text with only the engine's numbers filled in`, t.speech !== null && present(contentOf(t.speech.responseBody), decision, offer) === t.display);
    }
  });

  // 4. Outcome
  const status = left ? "left" : state.status;
  add("outcome", "Outcome matches the replay", status === b.outcome.status && (state.dealPrice ?? null) === b.outcome.dealPrice);
  if (state.dealPrice !== undefined) add("floor", `Deal price ${state.dealPrice} is at or above the secret floor ${secret.floor}`, state.dealPrice >= secret.floor);
  return checks;
}
