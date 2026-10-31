/** One row in the "Verified" panel. `required` checks decide the overall verdict. */
export interface Check {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  detail?: string;
}

/** Subset of a NEAR AI Cloud `model_attestations[]` entry that we verify. */
export interface ModelAttestation {
  model_name: string;
  signing_address: string;
  signing_algo: string;
  request_nonce: string;
  intel_quote: string;
  nvidia_payload: string;
  info: {
    compose_hash?: string;
    tcb_info: string | { app_compose?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
}

export interface AttestationReport {
  model_attestations?: ModelAttestation[];
  gateway_attestation?: unknown;
}

export interface CandidateResult {
  signingAddress: string;
  ok: boolean;
  checks: Check[];
}

export interface ModelVerification {
  model: string;
  nonce: string;
  verifiedAt: string;
  /** True iff at least one candidate passed every required check. */
  ok: boolean;
  /** Signing addresses that passed — chat signatures must recover to one of these. */
  trustedSigners: string[];
  candidates: CandidateResult[];
}
