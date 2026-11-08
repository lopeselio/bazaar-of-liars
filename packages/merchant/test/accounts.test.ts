import { describe, expect, it } from "vitest";
import { agentAccounts } from "../src/chain.js";

describe("agent accounts after a rekey", () => {
  const env = { BAZAAR_CONTRACT_ID: "v3.bazaar-liars.testnet" };

  it("defaults to <id>.<contract> when nothing was rekeyed", () => {
    expect(agentAccounts(env)).toEqual({});
  });

  it("reads moved agents from AGENT_ACCOUNTS", () => {
    expect(agentAccounts({ ...env, AGENT_ACCOUNTS: '{"vesey":"vesey-2.v3.bazaar-liars.testnet"}' })).toEqual({ vesey: "vesey-2.v3.bazaar-liars.testnet" });
  });

  it("refuses an account outside the contract", () => {
    expect(() => agentAccounts({ ...env, AGENT_ACCOUNTS: '{"vesey":"attacker.testnet"}' })).toThrow(/not a sub-account/);
  });
});

describe("signers follow the contract's record", () => {
  it("prefers the account the contract reports over AGENT_ACCOUNTS", async () => {
    const { agentSignersFromEnv } = await import("../src/chain.js");
    const env = { BAZAAR_CONTRACT_ID: "v3.bazaar-liars.testnet", AGENT_ACCOUNTS: '{"vesey":"vesey-2.v3.bazaar-liars.testnet"}', AGENT_KEYS: "{}" };
    const s = agentSignersFromEnv(["vesey", "deli"], env, { vesey: "vesey-3.v3.bazaar-liars.testnet" })!;
    expect(s.vesey.account).toBe("vesey-3.v3.bazaar-liars.testnet");
    expect(s.deli.account).toBe("deli.v3.bazaar-liars.testnet");
  });
});
