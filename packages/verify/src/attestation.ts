import { randomBytes } from "node:crypto";
import { checkComposeBinding, checkReportDataBinding, parseTdxQuote, verifyTdxQuoteOnline } from "./tdx.js";
import { verifyGpuOnline } from "./nvidia.js";
import type { AttestationReport, CandidateResult, Check, ModelAttestation, ModelVerification } from "./types.js";

export const NEARAI_API = "https://cloud-api.near.ai";

export const newNonce = () => randomBytes(32).toString("hex");

/** Fetch a model attestation report. Free / non-billable, but needs an API key. */
export async function fetchModelAttestation(model: string, nonce: string, apiKey: string): Promise<AttestationReport> {
  const url = `${NEARAI_API}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`attestation HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as AttestationReport;
}

function appComposeOf(a: ModelAttestation): string | undefined {
  const tcb = typeof a.info.tcb_info === "string" ? JSON.parse(a.info.tcb_info) : a.info.tcb_info;
  return tcb?.app_compose;
}

/** Checks that need no network: everything bound inside the quote itself. */
export function offlineChecks(a: ModelAttestation, nonce: string, model: string): Check[] {
  const checks: Check[] = [
    { id: "report.model", label: `Report is for ${model}`, ok: a.model_name === model, required: true },
    { id: "report.nonce", label: "Report echoes our nonce", ok: a.request_nonce?.toLowerCase() === nonce.toLowerCase(), required: true },
    { id: "report.algo", label: "Signing algorithm is ecdsa", ok: a.signing_algo === "ecdsa", required: true },
  ];
  let q;
  try {
    q = parseTdxQuote(a.intel_quote);
  } catch (e) {
    checks.push({ id: "tdx.parse", label: "TDX quote parses", ok: false, required: true, detail: (e as Error).message });
    return checks;
  }
  checks.push(
    { id: "tdx.version", label: "TDX quote v4 (TDX TEE)", ok: q.version === 4 && q.teeType === 0x81, required: true },
    { id: "tdx.debug", label: "TEE is not in debug mode", ok: !q.debug, required: true },
    ...checkReportDataBinding(q.reportData, a.signing_address, nonce),
    checkComposeBinding(q.mrConfigId, appComposeOf(a)),
  );
  return checks;
}

export interface VerifyOptions {
  /** Skip Intel PCS + NVIDIA NRAS calls (for tests / offline replay). */
  offline?: boolean;
}

export async function verifyModelReport(
  report: AttestationReport,
  model: string,
  nonce: string,
  opts: VerifyOptions = {},
): Promise<ModelVerification> {
  const atts = report.model_attestations ?? [];
  const candidates: CandidateResult[] = [];
  for (const a of atts) {
    const checks = offlineChecks(a, nonce, model);
    if (!opts.offline) {
      checks.push(await verifyTdxQuoteOnline(a.intel_quote));
      checks.push(...(await verifyGpuOnline(a.nvidia_payload, nonce)));
    }
    candidates.push({ signingAddress: a.signing_address, ok: checks.every((c) => c.ok || !c.required), checks });
  }
  const trustedSigners = candidates.filter((c) => c.ok).map((c) => c.signingAddress.toLowerCase());
  return {
    model,
    nonce,
    verifiedAt: new Date().toISOString(),
    ok: atts.length > 0 && trustedSigners.length > 0,
    trustedSigners,
    candidates,
  };
}

/** Fetch with a fresh nonce, then verify. */
export async function attestModel(model: string, apiKey: string, opts: VerifyOptions = {}) {
  const nonce = newNonce();
  const report = await fetchModelAttestation(model, nonce, apiKey);
  return { report, verification: await verifyModelReport(report, model, nonce, opts) };
}
