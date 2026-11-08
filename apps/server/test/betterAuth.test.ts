import { describe, expect, it } from "vitest";
import { betterAuthFromEnv } from "../src/betterAuth.js";

const { auth, host } = betterAuthFromEnv({ BETTER_AUTH_URL: "https://bazaar.example.test", BETTER_AUTH_SECRET: "x".repeat(40) } as NodeJS.ProcessEnv);
const verify = (body: object, origin?: string) =>
  auth.handler(
    new Request("https://bazaar.example.test/api/ba/near/verify", {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ signedMessage: { accountId: "alice.testnet", publicKey: "ed25519:x", signature: "ed25519:y" }, nonce: "00".repeat(32), accountId: "alice.testnet", ...body }),
    }),
  );

describe("wallet sign-in through better-near-auth", () => {
  it("signs for our own host", () => {
    expect(host).toBe("bazaar.example.test");
  });

  it("refuses a signature made for another site, before checking anything else", async () => {
    const r = await verify({ recipient: "evil.example", message: "Sign in to evil.example" }, "https://bazaar.example.test");
    expect(r.status).toBe(401);
    expect(await r.text()).toContain("different site");
  });

  it("refuses our recipient with a different message", async () => {
    const r = await verify({ recipient: host, message: "Transfer everything" }, "https://bazaar.example.test");
    expect(r.status).toBe(401);
  });

  it("refuses a sign-in sent from another origin, or with none", async () => {
    const ok = { recipient: host, message: `Sign in to ${host}` };
    expect((await verify(ok, "https://evil.example")).status).toBe(403);
    expect((await verify(ok)).status).toBe(403);
  });
});
