/**
 * Intel TDX quote checks.
 *
 * Offline: parse the quote body (v4, TD 1.0 report) and check what's bound into it.
 * Online:  verify the quote's signature chain back to Intel with Phala's dcap-qvl (WASM),
 *          fetching collateral from Intel's PCS — the same approach as nearai/nearai-cloud-verifier.
 */
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { sha256Hex } from "./hash.js";
import type { Check } from "./types.js";

const HEADER_LEN = 48;
// TD 1.0 report body field offsets (relative to body start).
const OFF = { tdAttributes: 120, mrConfigId: 184, reportData: 520 } as const;
const BODY_LEN = 584;

export const INTEL_PCS_URL = "https://api.trustedservices.intel.com/tdx/certification/v4";

export interface ParsedQuote {
  version: number;
  teeType: number;
  debug: boolean;
  mrConfigId: string;
  reportData: string;
}

export function parseTdxQuote(hex: string): ParsedQuote {
  const q = hexToBytes(hex);
  if (q.length < HEADER_LEN + BODY_LEN) throw new Error(`quote too short (${q.length} bytes)`);
  const body = q.subarray(HEADER_LEN, HEADER_LEN + BODY_LEN);
  const view = new DataView(q.buffer, q.byteOffset, q.byteLength);
  return {
    version: view.getUint16(0, true),
    teeType: view.getUint32(4, true),
    // TD_ATTRIBUTES bit 0 = DEBUG. A debuggable TD exposes its memory to the host.
    debug: (body[OFF.tdAttributes] & 1) === 1,
    mrConfigId: bytesToHex(body.subarray(OFF.mrConfigId, OFF.mrConfigId + 48)),
    reportData: bytesToHex(body.subarray(OFF.reportData, OFF.reportData + 64)),
  };
}

/**
 * NEAR AI Cloud binds the TEE-generated signing key and our nonce into report_data:
 *   [0..20) signing address · [20..32) zero padding · [32..64) request nonce
 * (Observed on live reports; matches the gateway's own `report_data` field.)
 */
export function checkReportDataBinding(reportDataHex: string, signingAddress: string, nonce: string): Check[] {
  const rd = hexToBytes(reportDataHex);
  const addr = signingAddress.toLowerCase().replace(/^0x/, "");
  return [
    {
      id: "tdx.binding.signer",
      label: "Signing key was generated inside the TEE (bound in TDX report data)",
      ok: bytesToHex(rd.subarray(0, 20)) === addr && rd.subarray(20, 32).every((b) => b === 0),
      required: true,
    },
    {
      id: "tdx.binding.nonce",
      label: "TDX report is fresh (contains our nonce)",
      ok: bytesToHex(rd.subarray(32, 64)) === nonce.toLowerCase(),
      required: true,
    },
  ];
}

/** mr_config_id = 0x01 ‖ sha256(app_compose): proves which container config the TEE booted. */
export function checkComposeBinding(mrConfigIdHex: string, appCompose: string | undefined): Check {
  if (!appCompose)
    return { id: "tdx.compose", label: "Container manifest matches TDX measurement", ok: false, required: true, detail: "no app_compose in report" };
  const composeHash = sha256Hex(appCompose);
  return {
    id: "tdx.compose",
    label: "Container manifest matches TDX measurement (mr_config_id)",
    ok: mrConfigIdHex.toLowerCase().startsWith("01" + composeHash),
    required: true,
    detail: `compose sha256 ${composeHash.slice(0, 16)}…`,
  };
}

/** Statuses where the quote's cryptography verifies. OutOfDate = platform TCB behind Intel's latest advisory. */
const TDX_STATUS_OK = new Set(["UpToDate", "OutOfDate"]);

export async function verifyTdxQuoteOnline(quoteHex: string, now = new Date()): Promise<Check> {
  const label = "Intel TDX quote signature chains to Intel (dcap-qvl)";
  try {
    // Loaded only for the online check, which runs under Node (the browser verifier stays offline).
    const { default: dcap } = await import("@phala/dcap-qvl-node");
    const raw = hexToBytes(quoteHex);
    const collateral = await dcap.js_get_collateral(INTEL_PCS_URL, raw);
    const result = dcap.js_verify(raw, collateral, BigInt(Math.floor(now.getTime() / 1000)));
    const status: string | undefined = result?.status;
    return {
      id: "tdx.quote",
      label,
      ok: status !== undefined && TDX_STATUS_OK.has(status),
      required: true,
      detail: status === "OutOfDate" ? "status OutOfDate (valid signature; platform TCB behind latest advisory)" : `status ${status}`,
    };
  } catch (e) {
    return { id: "tdx.quote", label, ok: false, required: true, detail: (e as Error).message };
  }
}
