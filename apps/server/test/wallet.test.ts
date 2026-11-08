import { describe, expect, it, vi } from "vitest";
import { generateKey, verifyNep413Signature } from "near-kit";
import { SIGN_IN_MESSAGE, WalletRpcError, nep413Hash, rpcKeyReader, verifyEd25519, verifyWalletSignIn, type KeyReader } from "../src/wallet.js";

const HOST = "bazaar.example.test";
const BACK = `https://${HOST}/city/`;
const nonce = Buffer.alloc(32, 7);
const nonceB64 = nonce.toString("base64");

/** A wallet's NEP-413 signature, made by near-kit (an independent implementation). */
function walletSign(accountId: string, o: { nonce?: Buffer; recipient?: string; callbackUrl?: string } = {}) {
  const key = generateKey();
  const signed = key.signNep413Message!(accountId, { message: SIGN_IN_MESSAGE, recipient: o.recipient ?? HOST, nonce: o.nonce ?? nonce, callbackUrl: o.callbackUrl });
  return { key, signed };
}

const issued = async (n: string) => (n === nonceB64 ? { recipient: HOST } : null);
const once = () => {
  const used = new Set<string>();
  return async (n: string) => (used.has(n) ? false : (used.add(n), true));
};
const fullKey: KeyReader = async () => "full";
const proofOf = (signed: { publicKey: string; signature: string }, over: Record<string, unknown> = {}) => ({
  accountId: "alice.testnet",
  publicKey: signed.publicKey,
  signature: signed.signature,
  nonce: nonceB64,
  callbackUrl: BACK,
  ...over,
});

describe("wallet sign-in (NEP-413)", () => {
  it("accepts a signature near-kit made, so our payload bytes match the standard", async () => {
    const { signed } = walletSign("alice.testnet");
    expect(await verifyWalletSignIn(proofOf(signed), issued, once(), fullKey)).toBe("alice.testnet");
  });

  it("agrees with near-kit's own verifier, including a callback URL", async () => {
    const { signed } = walletSign("alice.testnet", { callbackUrl: BACK });
    const hash = nep413Hash({ message: SIGN_IN_MESSAGE, nonce, recipient: HOST, callbackUrl: BACK });
    expect(verifyEd25519(signed.publicKey, hash, signed.signature)).toBe(true);
    expect(await verifyNep413Signature(signed, { message: SIGN_IN_MESSAGE, recipient: HOST, nonce, callbackUrl: BACK }, { maxAge: Infinity })).toBe(true);
    expect(await verifyWalletSignIn(proofOf(signed), issued, once(), fullKey)).toBe("alice.testnet");
  });

  it("is bound to our site: another recipient, or a wallet returning elsewhere, is refused", async () => {
    const elsewhere = walletSign("alice.testnet", { recipient: "evil.example" });
    await expect(verifyWalletSignIn(proofOf(elsewhere.signed), issued, once(), fullKey)).rejects.toThrow(/doesn't match/);
    const { signed } = walletSign("alice.testnet");
    await expect(verifyWalletSignIn(proofOf(signed, { callbackUrl: "https://evil.example/collect" }), issued, once(), fullKey)).rejects.toThrow(/return to this site/);
    await expect(verifyWalletSignIn(proofOf(signed, { callbackUrl: null }), issued, once(), fullKey)).rejects.toThrow(/return to this site/);
  });

  it("refuses a nonce we never issued, and a reused one", async () => {
    const { signed } = walletSign("alice.testnet");
    await expect(verifyWalletSignIn(proofOf(signed), async () => null, once(), fullKey)).rejects.toThrow(/expired/);
    const consume = once();
    await verifyWalletSignIn(proofOf(signed), issued, consume, fullKey);
    await expect(verifyWalletSignIn(proofOf(signed), issued, consume, fullKey)).rejects.toThrow(/already used/);
  });

  it("a bad signature doesn't use the nonce up", async () => {
    const consume = vi.fn(once());
    const other = walletSign("alice.testnet", { nonce: Buffer.alloc(32, 9) });
    await expect(verifyWalletSignIn(proofOf(other.signed), issued, consume, fullKey)).rejects.toThrow(/doesn't match/);
    await expect(verifyWalletSignIn(proofOf(other.signed, { signature: "ed25519:0OIl" }), issued, consume, fullKey)).rejects.toThrow(/doesn't match/);
    expect(consume).not.toHaveBeenCalled();
  });

  it("refuses a key that isn't on the account, or isn't full-access", async () => {
    const { signed } = walletSign("alice.testnet");
    await expect(verifyWalletSignIn(proofOf(signed, { accountId: "bob.testnet" }), issued, once(), async () => "none")).rejects.toThrow(/isn't on the account/);
    await expect(verifyWalletSignIn(proofOf(signed), issued, once(), async () => "function-call")).rejects.toThrow(/full-access/);
  });

  it("only takes NEAR account ids", async () => {
    const { signed } = walletSign("x");
    await expect(verifyWalletSignIn(proofOf(signed, { accountId: "../etc" }), issued, once(), fullKey)).rejects.toThrow(/account id/);
  });
});

describe("reading a key's permission from the chain", () => {
  const reply = (result: unknown, status = 200) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(status === 200 ? JSON.stringify({ jsonrpc: "2.0", id: 1, result }) : "<html>busy</html>", { status }));
  it("tells full-access, function-call and missing keys apart (a missing key is an error inside result)", async () => {
    const read = rpcKeyReader("https://rpc.example");
    reply({ nonce: 1, permission: "FullAccess", block_height: 1 });
    expect(await read("a.testnet", "ed25519:x")).toBe("full");
    reply({ nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: "c", method_names: [] } } });
    expect(await read("a.testnet", "ed25519:x")).toBe("function-call");
    reply({ error: "access key ed25519:x does not exist while viewing", logs: [], block_height: 1 });
    expect(await read("a.testnet", "ed25519:x")).toBe("none");
  });

  it("reports an RPC outage as an outage, not as 'no key'", async () => {
    reply(null, 429);
    await expect(rpcKeyReader("https://rpc.example")("a.testnet", "ed25519:x")).rejects.toBeInstanceOf(WalletRpcError);
  });
});
