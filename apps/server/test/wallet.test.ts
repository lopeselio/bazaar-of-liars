import { describe, expect, it } from "vitest";
import { generateKey, verifyNep413Signature } from "near-kit";
import { SIGN_IN_MESSAGE, SIGN_IN_RECIPIENT, nep413Hash, rpcKeyReader, verifyEd25519, verifyWalletSignIn, type KeyReader } from "../src/wallet.js";
import { vi } from "vitest";

const nonce = Buffer.alloc(32, 7);
const nonceB64 = nonce.toString("base64");

/** A wallet's NEP-413 signature, made by near-kit (an independent implementation). */
function walletSign(accountId: string, n = nonce, callbackUrl?: string) {
  const key = generateKey();
  const signed = key.signNep413Message!(accountId, { message: SIGN_IN_MESSAGE, recipient: SIGN_IN_RECIPIENT, nonce: n, callbackUrl });
  return { key, signed };
}

const once = () => {
  const used = new Set<string>();
  return async (n: string) => (n === nonceB64 && !used.has(n) ? (used.add(n), true) : false);
};
const fullKey: KeyReader = async () => "full";

describe("wallet sign-in (NEP-413)", () => {
  it("accepts a signature near-kit made, so our payload bytes match the standard", async () => {
    const { signed } = walletSign("alice.testnet");
    const account = await verifyWalletSignIn({ accountId: "alice.testnet", publicKey: signed.publicKey, signature: signed.signature, nonce: nonceB64 }, once(), fullKey);
    expect(account).toBe("alice.testnet");
  });

  it("agrees with near-kit's own verifier, including a callback URL", async () => {
    const { signed } = walletSign("alice.testnet", nonce, "https://example.test/city/");
    const hash = nep413Hash({ message: SIGN_IN_MESSAGE, nonce, recipient: SIGN_IN_RECIPIENT, callbackUrl: "https://example.test/city/" });
    expect(verifyEd25519(signed.publicKey, hash, signed.signature)).toBe(true);
    expect(
      await verifyNep413Signature(signed, { message: SIGN_IN_MESSAGE, recipient: SIGN_IN_RECIPIENT, nonce, callbackUrl: "https://example.test/city/" }, { maxAge: Infinity }),
    ).toBe(true);
  });

  it("refuses a reused nonce, a wrong message, a key not on the account, or a function-call key", async () => {
    const { signed } = walletSign("alice.testnet");
    const proof = { accountId: "alice.testnet", publicKey: signed.publicKey, signature: signed.signature, nonce: nonceB64 };
    const consume = once();
    await verifyWalletSignIn(proof, consume, fullKey);
    await expect(verifyWalletSignIn(proof, consume, fullKey)).rejects.toThrow(/already used/);
    // Same signature presented as someone else's account: the key isn't theirs.
    await expect(verifyWalletSignIn({ ...proof, accountId: "bob.testnet" }, once(), async () => "none")).rejects.toThrow(/isn't on the account/);
    await expect(verifyWalletSignIn(proof, once(), async () => "function-call")).rejects.toThrow(/full-access/);
    const other = walletSign("alice.testnet", Buffer.alloc(32, 9));
    await expect(verifyWalletSignIn({ ...proof, signature: other.signed.signature }, once(), fullKey)).rejects.toThrow(/doesn't match/);
  });

  it("accepts wallets that sign with or without the callback URL in the payload", async () => {
    const { signed } = walletSign("alice.testnet");
    const account = await verifyWalletSignIn(
      { accountId: "alice.testnet", publicKey: signed.publicKey, signature: signed.signature, nonce: nonceB64, callbackUrl: "https://example.test/city/" },
      once(),
      fullKey,
    );
    expect(account).toBe("alice.testnet");
  });

  it("only takes NEAR account ids", async () => {
    const { signed } = walletSign("x");
    await expect(verifyWalletSignIn({ accountId: "../etc", publicKey: signed.publicKey, signature: signed.signature, nonce: nonceB64 }, once(), fullKey)).rejects.toThrow(/account id/);
  });
});

describe("reading a key's permission from the chain", () => {
  const reply = (result: unknown) => vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result })));
  it("tells full-access, function-call and missing keys apart (a missing key is an error inside result)", async () => {
    const read = rpcKeyReader("https://rpc.example");
    reply({ nonce: 1, permission: "FullAccess", block_height: 1 });
    expect(await read("a.testnet", "ed25519:x")).toBe("full");
    reply({ nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: "c", method_names: [] } } });
    expect(await read("a.testnet", "ed25519:x")).toBe("function-call");
    reply({ error: "access key ed25519:x does not exist while viewing", logs: [], block_height: 1 });
    expect(await read("a.testnet", "ed25519:x")).toBe("none");
  });
});
