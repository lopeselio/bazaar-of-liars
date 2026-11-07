import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { checkDeedCertificate, deedMessage, ethAddressOf } from "../src/index.js";

// A real certificate from v3.bazaar-liars.testnet, signed by v1.signer-prod.testnet.
const CONTRACT = "v3.bazaar-liars.testnet";
const KEY = "secp256k1:3UXyUccQURtrPrRkhenGHGMc9WoANziNnJWqLEpp2u8PGgwuxPAFR9i135tMchq24ZmJHRnrSAwZxPXPpsn4MbcT";
const CERT = {
  slot: "corner-1",
  owner: "guest-a0c7100000000002",
  message: "Bazaar of Liars deed corner-1 (NEAR contract v3.bazaar-liars.testnet) is owned by guest-a0c7100000000002 as of NEAR block 276632718.",
  signature: "0x0814a2c94a4c240cfa8912286828f07a818e2dc9ebf7c369f34293ddc764d160526a8e5ae4e59ffb424bebe1bb725f4499e0f2771fc41468d6102d2856da591c1c",
  block_height: 276632718,
};

describe("deed certificates", () => {
  it("derives the bazaar's Ethereum address from the MPC key", () => {
    expect(ethAddressOf(KEY)).toBe("0x4bbca4FD4b5887426F5D86F588f36091A9b1c3a9");
    expect(() => ethAddressOf("ed25519:abc")).toThrow();
  });

  it("matches the contract's message byte for byte", () => {
    expect(deedMessage(CERT.slot, CERT.owner, CONTRACT, CERT.block_height)).toBe(CERT.message);
  });

  it("verifies a real MPC-signed certificate", () => {
    const checks = checkDeedCertificate(CERT, { contractId: CONTRACT, ethAddress: ethAddressOf(KEY), currentOwner: CERT.owner });
    expect(checks.map((c) => c.ok)).toEqual([true, true, true]);
  });

  it("rejects an edited owner, a forged signer and a stale owner", () => {
    const eth = ethAddressOf(KEY);
    const edited = { ...CERT, owner: "guest-eve", message: CERT.message.replace("guest-a0c7100000000002", "guest-eve") };
    expect(checkDeedCertificate(edited, { contractId: CONTRACT, ethAddress: eth })[0].ok).toBe(false);
    const forger = Wallet.createRandom();
    const forged = { ...CERT, signature: forger.signMessageSync(CERT.message) };
    expect(checkDeedCertificate(forged, { contractId: CONTRACT, ethAddress: eth })[0].ok).toBe(false);
    expect(checkDeedCertificate(CERT, { contractId: CONTRACT, ethAddress: eth, currentOwner: "guest-new" })[2].ok).toBe(false);
    expect(checkDeedCertificate(CERT, { contractId: "other.testnet", ethAddress: eth })[1].ok).toBe(false);
  });
});
