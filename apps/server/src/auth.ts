/**
 * Signing in with NEAR Auth (Google, email, … via Auth0, keys held by NEAR's MPC network).
 *
 * The browser logs in with the NEAR Auth Auth0 tenant and sends us its ID token. We check it
 * ourselves (RS256 signature against the tenant's published keys, issuer, audience, expiry), then
 * ask NEAR's MPC contract which public key that identity controls: the same derivation NEAR Auth
 * uses to sign for the user (`derived_public_key(path = "jwt#https://<domain>/#<sub>",
 * predecessor = the NEAR Auth contract)`). The player's account is the implicit NEAR account of
 * that key. We then hand out a session token (HMAC) for that account.
 *
 * Nothing here can sign for the user; it only establishes who they are.
 */
import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as rsaVerify, type JsonWebKey } from "node:crypto";

export interface AuthConfig {
  /** Auth0 tenant NEAR Auth uses (testnet: login.testnet.fast-auth.com). */
  domain: string;
  /** Auth0 client id the browser logs in with (testnet: NEAR Auth's shared dev client). */
  clientId: string;
  /** NEAR Auth contract: the predecessor for key derivation. */
  fastAuthContract: string;
  /** NEAR's MPC signer contract. */
  mpcContract: string;
  rpc: string;
  sessionSecret: Buffer;
  sessionTtlMs: number;
}

export const NEAR_AUTH_TESTNET = {
  domain: "login.testnet.fast-auth.com",
  clientId: "np8paqIpMWmNbzT4xAvOOapZBjsOpptl",
  fastAuthContract: "fast-auth.testnet",
  mpcContract: "v1.signer-prod.testnet",
  rpc: "https://rpc.testnet.fastnear.com",
};

export function authFromEnv(env = process.env): AuthConfig {
  const secret = env.SESSION_SECRET;
  if (!secret) console.warn("⚠ SESSION_SECRET unset: sessions won't survive a restart or work across replicas");
  return {
    domain: env.NEAR_AUTH_DOMAIN ?? NEAR_AUTH_TESTNET.domain,
    clientId: env.NEAR_AUTH_CLIENT_ID ?? NEAR_AUTH_TESTNET.clientId,
    fastAuthContract: env.NEAR_AUTH_CONTRACT ?? NEAR_AUTH_TESTNET.fastAuthContract,
    mpcContract: env.NEAR_AUTH_MPC ?? NEAR_AUTH_TESTNET.mpcContract,
    rpc: env.NEAR_AUTH_RPC ?? NEAR_AUTH_TESTNET.rpc,
    sessionSecret: secret ? Buffer.from(secret) : randomBytes(32),
    sessionTtlMs: 30 * 24 * 3_600_000,
  };
}

// ---------- ID token ----------

export class AuthError extends Error {}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export type JwksFetcher = (url: string) => Promise<{ keys: (JsonWebKey & { kid?: string })[] }>;
const jwksCache = new Map<string, { at: number; keys: (JsonWebKey & { kid?: string })[] }>();
export const fetchJwks: JwksFetcher = async (url) => {
  const hit = jwksCache.get(url);
  if (hit && Date.now() - hit.at < 3_600_000) return { keys: hit.keys };
  const r = (await fetch(url).then((x) => x.json())) as { keys: (JsonWebKey & { kid?: string })[] };
  jwksCache.set(url, { at: Date.now(), keys: r.keys });
  return r;
};

/** Verify a NEAR Auth ID token and return its subject. Only RS256 from the tenant's own keys. */
export async function verifyIdToken(jwt: string, cfg: Pick<AuthConfig, "domain" | "clientId">, jwks: JwksFetcher = fetchJwks, now = Date.now()): Promise<string> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new AuthError("malformed token");
  const json = <T>(part: string): T => {
    try {
      return JSON.parse(b64url(part).toString()) as T;
    } catch {
      throw new AuthError("malformed token");
    }
  };
  const header = json<{ alg?: string; kid?: string }>(parts[0]);
  if (header.alg !== "RS256") throw new AuthError("unsupported token algorithm");
  const issuer = `https://${cfg.domain}/`;
  const { keys } = await jwks(`${issuer}.well-known/jwks.json`);
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) throw new AuthError("unknown signing key");
  const ok = rsaVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), b64url(parts[2]));
  if (!ok) throw new AuthError("bad token signature");
  const c = json<{ iss?: string; aud?: string | string[]; exp?: number; sub?: string }>(parts[1]);
  if (c.iss !== issuer) throw new AuthError("wrong issuer");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(cfg.clientId)) throw new AuthError("token is for another app");
  if (!c.exp || c.exp * 1000 < now - 60_000) throw new AuthError("token expired");
  // The same constraints NEAR Auth's guard puts on a subject.
  if (!c.sub || c.sub.includes("#") || c.sub.length > 256) throw new AuthError("bad subject");
  return c.sub;
}

// ---------- the account an identity controls ----------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

/** "ed25519:<base58>" → the implicit NEAR account id (64 hex chars). */
export function implicitAccount(publicKey: string): string {
  const [type, data] = publicKey.split(":");
  if (type !== "ed25519") throw new Error(`expected an ed25519 key, got ${type}`);
  const raw = base58Decode(data);
  if (raw.length !== 32) throw new Error("ed25519 keys are 32 bytes");
  return raw.toString("hex");
}

/** The ed25519 key NEAR Auth derives for this identity, from NEAR's MPC contract. */
export async function derivedPublicKey(sub: string, cfg: Pick<AuthConfig, "domain" | "fastAuthContract" | "mpcContract" | "rpc">): Promise<string> {
  const args = { path: `jwt#https://${cfg.domain}/#${sub}`, predecessor: cfg.fastAuthContract, domain_id: 1 };
  const r = (await fetch(cfg.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "auth",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: cfg.mpcContract, method_name: "derived_public_key", args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    }),
  }).then((x) => x.json())) as { result?: { result: number[] }; error?: unknown };
  if (!r.result) throw new Error(`derived_public_key failed: ${JSON.stringify(r.error).slice(0, 200)}`);
  return JSON.parse(Buffer.from(r.result.result).toString()) as string;
}

// ---------- sessions ----------

const IMPLICIT_RE = /^[0-9a-f]{64}$/;
export const isAccountPlayer = (p: string) => IMPLICIT_RE.test(p);

export function issueSession(account: string, cfg: Pick<AuthConfig, "sessionSecret" | "sessionTtlMs">, now = Date.now()) {
  const exp = now + cfg.sessionTtlMs;
  const sig = createHmac("sha256", cfg.sessionSecret).update(`${account}.${exp}`).digest("base64url");
  return { token: `${account}.${exp}.${sig}`, exp };
}

/** The account a session token is for, or null if it's forged or expired. */
export function sessionAccount(token: string | undefined, cfg: Pick<AuthConfig, "sessionSecret">, now = Date.now()): string | null {
  const [account, exp, sig] = (token ?? "").split(".");
  if (!account || !exp || !sig || !IMPLICIT_RE.test(account) || Number(exp) < now) return null;
  const want = createHmac("sha256", cfg.sessionSecret).update(`${account}.${exp}`).digest();
  const got = Buffer.from(sig, "base64url");
  return got.length === want.length && timingSafeEqual(got, want) ? account : null;
}
