/**
 * NVIDIA GPU attestation via NRAS.
 * Unlike a plain decode, we verify every JWT's signature against NVIDIA's published JWKS,
 * so a forged "x-nvidia-overall-att-result: true" can't pass.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Check } from "./types.js";

export const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
export const NRAS_ISSUER = "https://nras.attestation.nvidia.com";
const jwks = createRemoteJWKSet(new URL(`${NRAS_ISSUER}/.well-known/jwks.json`));

type NrasResponse = [["JWT", string], Record<string, string>];

export async function verifyGpuOnline(nvidiaPayloadJson: string, nonce: string): Promise<Check[]> {
  const checks: Check[] = [];
  const payload = JSON.parse(nvidiaPayloadJson) as { nonce?: string };
  checks.push({
    id: "gpu.payload.nonce",
    label: "GPU evidence was generated for our nonce",
    ok: payload.nonce?.toLowerCase() === nonce.toLowerCase(),
    required: true,
  });

  let body: NrasResponse;
  try {
    const res = await fetch(NRAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: nvidiaPayloadJson,
    });
    if (!res.ok) throw new Error(`NRAS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    body = (await res.json()) as NrasResponse;
  } catch (e) {
    checks.push({ id: "gpu.nras", label: "NVIDIA NRAS attested the GPUs", ok: false, required: true, detail: (e as Error).message });
    return checks;
  }

  const verify = async (jwt: string): Promise<JWTPayload | Error> => {
    try {
      return (await jwtVerify(jwt, jwks, { issuer: NRAS_ISSUER })).payload; // also enforces exp
    } catch (e) {
      return e as Error;
    }
  };

  const overall = await verify(body[0][1]);
  checks.push({
    id: "gpu.nras.overall",
    label: "NVIDIA signed an overall PASS for the GPUs (JWT verified against NVIDIA JWKS)",
    ok: !(overall instanceof Error) && overall["x-nvidia-overall-att-result"] === true && overall.eat_nonce === nonce,
    required: true,
    detail: overall instanceof Error ? overall.message : undefined,
  });

  const gpus = Object.entries(body[1] ?? {});
  checks.push({ id: "gpu.count", label: `GPU reports present (${gpus.length})`, ok: gpus.length > 0, required: true });
  for (const [gpu, jwt] of gpus) {
    const c = await verify(jwt);
    const fails: string[] = [];
    if (c instanceof Error) fails.push(c.message);
    else {
      if (c.eat_nonce !== nonce) fails.push("nonce");
      if (c.secboot !== true) fails.push("secure boot off");
      if (c.dbgstat !== "disabled") fails.push("debug enabled");
      if (c.measres !== "success") fails.push("measurements failed");
      if (c["x-nvidia-attestation-warning"] != null) fails.push(`warning: ${c["x-nvidia-attestation-warning"]}`);
      for (const [k, v] of Object.entries(c))
        if (/^x-nvidia-.*-(verified|validated)$/.test(k) && v !== true) fails.push(k);
    }
    checks.push({
      id: `gpu.${gpu}`,
      label: `${gpu}: secure boot, debug off, measurements & RIM signatures valid`,
      ok: fails.length === 0,
      required: true,
      detail: fails.length ? fails.join(", ") : (c as JWTPayload).hwmodel as string | undefined,
    });
  }
  return checks;
}
