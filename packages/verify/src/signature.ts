/**
 * Chat reply signatures (used once completions are enabled).
 * provider_tee signs `${model}:${sha256(requestBody)}:${sha256(responseBody)}` with EIP-191 ECDSA.
 * The recovered signer must be one of the attested `trustedSigners` — that closes the chain:
 *   GPU (NRAS) → CPU TEE (TDX) → signing key bound in report_data → this reply.
 */
import { sha256Hex as hashHex } from "./hash.js";
import { verifyMessage } from "ethers";
import type { Check } from "./types.js";

export const sha256Hex = (s: string | Uint8Array) => hashHex(s);

export interface ChatSignature {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: "provider_tee" | "gateway";
}

export function verifyChatSignature(
  sig: ChatSignature,
  expected: { model: string; requestBody: string; responseBody: string; trustedSigners: string[] },
): Check[] {
  const reqHash = sha256Hex(expected.requestBody);
  const resHash = sha256Hex(expected.responseBody);
  let recovered = "";
  try {
    recovered = verifyMessage(sig.text, sig.signature).toLowerCase();
  } catch {
    /* leave empty → checks fail */
  }
  return [
    { id: "sig.kind", label: "Signed inside the model TEE (provider_tee)", ok: (sig.signature_kind ?? "provider_tee") === "provider_tee", required: true },
    { id: "sig.payload", label: "Signature covers this exact request and reply", ok: sig.text === `${expected.model}:${reqHash}:${resHash}`, required: true },
    { id: "sig.valid", label: "Signature is valid for the claimed TEE key", ok: recovered !== "" && recovered === sig.signing_address.toLowerCase(), required: true },
    { id: "sig.attested", label: "Signing key matches a verified attestation", ok: expected.trustedSigners.includes(recovered), required: true },
  ];
}
