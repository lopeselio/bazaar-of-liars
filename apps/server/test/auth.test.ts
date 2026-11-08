import { describe, expect, it } from "vitest";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { AuthError, base58Decode, implicitAccount, issueSession, sessionAccount, verifyIdToken, type JwksFetcher } from "../src/auth.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
const jwks: JwksFetcher = async () => ({ keys: [jwk] });
const cfg = { domain: "login.test", clientId: "client-1" };
const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = 1_800_000_000_000;
function token(claims: object, header: object = { alg: "RS256", kid: "k1" }) {
  const body = `${enc(header)}.${enc(claims)}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}
const good = { iss: "https://login.test/", aud: "client-1", exp: now / 1000 + 600, sub: "google-oauth2|42" };

describe("NEAR Auth ID tokens", () => {
  it("accepts a valid token and returns its subject", async () => {
    expect(await verifyIdToken(token(good), cfg, jwks, now)).toBe("google-oauth2|42");
  });

  it("rejects forged, foreign, expired and odd tokens", async () => {
    const bad = async (t: string) => expect(verifyIdToken(t, cfg, jwks, now)).rejects.toBeInstanceOf(AuthError);
    await bad("x.y.z");
    await bad("not-a-token");
    await bad(token({ ...good, aud: "someone-else" }));
    await bad(token({ ...good, iss: "https://evil.test/" }));
    await bad(token({ ...good, exp: now / 1000 - 3600 }));
    await bad(token({ ...good, sub: "a#b" }));
    await bad(token(good, { alg: "RS256", kid: "other" }));
    const t = token(good).split(".");
    await bad(`${t[0]}.${enc({ ...good, sub: "google-oauth2|99" })}.${t[2]}`); // tampered claims
    // "alg confusion": an HS256 token signed with the public key as an HMAC secret.
    const h = `${enc({ alg: "HS256", kid: "k1" })}.${enc(good)}`;
    const mac = createHmac("sha256", JSON.stringify(jwk)).update(h).digest("base64url");
    await bad(`${h}.${mac}`);
  });
});

describe("accounts and sessions", () => {
  it("turns an ed25519 key into its implicit account", () => {
    expect(base58Decode("11111111111111111111111111111111").toString("hex")).toBe("00".repeat(32));
    expect(implicitAccount("ed25519:11111111111111111111111111111111")).toBe("00".repeat(32));
    expect(() => implicitAccount("secp256k1:abc")).toThrow();
  });

  it("issues sessions only it can verify", () => {
    const c = { sessionSecret: Buffer.from("s3cret"), sessionTtlMs: 60_000 };
    const acct = "ab".repeat(32);
    const { token: t } = issueSession(acct, c, now);
    expect(sessionAccount(t, c, now)).toBe(acct);
    expect(sessionAccount(t, c, now + 120_000)).toBeNull(); // expired
    expect(sessionAccount(t, { sessionSecret: Buffer.from("other") }, now)).toBeNull();
    const enc = (a: string) => Buffer.from(a).toString("base64url");
    expect(sessionAccount(t.replace(enc(acct), enc("cd".repeat(32))), c, now)).toBeNull();
    expect(sessionAccount(undefined, c, now)).toBeNull();
  });

  it("carries named accounts (with dots) from wallet sign-in, and rejects ids that aren't accounts", () => {
    const c = { sessionSecret: Buffer.from("s3cret"), sessionTtlMs: 60_000 };
    const { token } = issueSession("alice.testnet", c, now);
    expect(token.split(".")).toHaveLength(3);
    expect(sessionAccount(token, c, now)).toBe("alice.testnet");
    expect(sessionAccount(issueSession("guest-0123abcd", c, now).token, c, now)).toBeNull();
    expect(sessionAccount(token.replace(Buffer.from("alice.testnet").toString("base64url"), Buffer.from("bob.testnet").toString("base64url")), c, now)).toBeNull();
    // Exactly three parts, and a plain number for the expiry.
    expect(sessionAccount(`${token}.extra`, c, now)).toBeNull();
    const [enc, , sig] = token.split(".");
    expect(sessionAccount(`${enc}.Infinity.${sig}`, c, now)).toBeNull();
  });
});
