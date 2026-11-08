// Run the open-source proof verifier in this browser: the same code as `pnpm verify:haggle`
// (packages/merchant/src/bundle.ts), loaded on demand. It re-checks the commitment, every TEE
// signature against the attested key, the replay through the rules engine, and the contract's
// record on NEAR (read straight from public RPC). Nothing goes through our server.

export interface SelfCheck {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface SelfCheckResult {
  checks: SelfCheck[];
  failed: number;
  ms: number;
}

export async function checkBundleHere(bundle: unknown): Promise<SelfCheckResult> {
  const t0 = performance.now();
  const { verifyBundle } = await import("@bazaar/merchant/bundle");
  const checks = await verifyBundle(bundle as Parameters<typeof verifyBundle>[0], { online: false });
  return { checks, failed: checks.filter((c) => !c.ok).length, ms: Math.round(performance.now() - t0) };
}
