import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Wallet, hashMessage } from "ethers";
import {
  checkReportDataBinding,
  offlineChecks,
  parseTdxQuote,
  sha256Hex,
  verifyChatSignature,
  verifyModelReport,
  type AttestationReport,
} from "../src/index.js";

// A real Qwen3.6 attestation captured from cloud-api.near.ai (public data, no secrets).
const fixture = JSON.parse(readFileSync(new URL("./fixtures/attestation-qwen36.json", import.meta.url), "utf8")) as {
  nonce: string;
  report: AttestationReport;
};
const MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
const att = fixture.report.model_attestations![0];

describe("TDX quote (offline, real fixture)", () => {
  it("parses a v4 TDX quote that is not in debug mode", () => {
    const q = parseTdxQuote(att.intel_quote);
    expect(q.version).toBe(4);
    expect(q.teeType).toBe(0x81);
    expect(q.debug).toBe(false);
  });

  it("passes every offline check for the genuine report", () => {
    const failed = offlineChecks(att, fixture.nonce, MODEL).filter((c) => !c.ok);
    expect(failed).toEqual([]);
  });

  it("rejects a different nonce (replay)", () => {
    const other = "11".repeat(32);
    const checks = offlineChecks({ ...att, request_nonce: other }, other, MODEL);
    expect(checks.find((c) => c.id === "tdx.binding.nonce")!.ok).toBe(false);
  });

  it("rejects a swapped signing address (key not from the TEE)", () => {
    const fake = Wallet.createRandom().address;
    const checks = offlineChecks({ ...att, signing_address: fake }, fixture.nonce, MODEL);
    expect(checks.find((c) => c.id === "tdx.binding.signer")!.ok).toBe(false);
  });

  it("rejects a tampered container manifest", () => {
    const tcb = att.info.tcb_info as { app_compose: string };
    const tampered = { ...tcb, app_compose: tcb.app_compose.replace("services", "servicez") };
    const checks = offlineChecks({ ...att, info: { ...att.info, tcb_info: tampered } }, fixture.nonce, MODEL);
    expect(checks.find((c) => c.id === "tdx.compose")!.ok).toBe(false);
  });

  it("binding check requires zero padding between address and nonce", () => {
    const addr = "ab".repeat(20);
    const nonce = "cd".repeat(32);
    expect(checkReportDataBinding(addr + "00".repeat(12) + nonce, "0x" + addr, nonce).every((c) => c.ok)).toBe(true);
    expect(checkReportDataBinding(addr + "01" + "00".repeat(11) + nonce, "0x" + addr, nonce)[0].ok).toBe(false);
  });

  it("an empty model_attestations list is never verified", async () => {
    const v = await verifyModelReport({ model_attestations: [] }, MODEL, fixture.nonce, { offline: true });
    expect(v.ok).toBe(false);
  });

  it("trusts the fixture's signer in offline mode", async () => {
    const v = await verifyModelReport(fixture.report, MODEL, fixture.nonce, { offline: true });
    expect(v.ok).toBe(true);
    expect(v.trustedSigners).toEqual([att.signing_address.toLowerCase()]);
  });
});

describe("chat signatures", () => {
  const wallet = Wallet.createRandom();
  const requestBody = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "70?" }] });
  const responseBody = JSON.stringify({ id: "chat-1", choices: [{ message: { content: "75, final." } }] });
  const text = `${MODEL}:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
  const trustedSigners = [wallet.address.toLowerCase()];

  it("accepts a valid provider_tee signature from an attested key", async () => {
    const sig = { text, signature: await wallet.signMessage(text), signing_address: wallet.address, signing_algo: "ecdsa", signature_kind: "provider_tee" as const };
    expect(verifyChatSignature(sig, { model: MODEL, requestBody, responseBody, trustedSigners }).every((c) => c.ok)).toBe(true);
  });

  it("rejects a reply that was edited after signing", async () => {
    const sig = { text, signature: await wallet.signMessage(text), signing_address: wallet.address, signing_algo: "ecdsa" };
    const checks = verifyChatSignature(sig, { model: MODEL, requestBody, responseBody: responseBody.replace("75", "95"), trustedSigners });
    expect(checks.find((c) => c.id === "sig.payload")!.ok).toBe(false);
  });

  it("rejects a valid signature from a key that wasn't attested", async () => {
    const rogue = Wallet.createRandom();
    const sig = { text, signature: await rogue.signMessage(text), signing_address: rogue.address, signing_algo: "ecdsa" };
    const checks = verifyChatSignature(sig, { model: MODEL, requestBody, responseBody, trustedSigners });
    expect(checks.find((c) => c.id === "sig.valid")!.ok).toBe(true);
    expect(checks.find((c) => c.id === "sig.attested")!.ok).toBe(false);
  });

  it("rejects gateway-kind signatures (model output not proven)", async () => {
    const sig = { text, signature: await wallet.signMessage(text), signing_address: wallet.address, signing_algo: "ecdsa", signature_kind: "gateway" as const };
    expect(verifyChatSignature(sig, { model: MODEL, requestBody, responseBody, trustedSigners })[0].ok).toBe(false);
  });

  it("uses EIP-191 personal_sign hashing", () => {
    expect(hashMessage(text)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
