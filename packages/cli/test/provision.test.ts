/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from "vitest";

// Every provision call goes through wrangler; each test says what it prints.
const commands = vi.hoisted(() => ({ wrangler: vi.fn() }));
vi.mock("../src/commands", () => ({ wrangler: commands.wrangler }));

import { listDatabases, selectedAccount, selectedAccountId, workerExists, workerSecretNames } from "../src/provision";

const ACCOUNT_A = "a".repeat(32);
const ACCOUNT_B = "0123456789abcdef0123456789ABCDEF";

function prints(stdout: unknown, status = 0, stderr = "") {
  commands.wrangler.mockReturnValueOnce({
    status,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr,
  });
}

const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
afterEach(() => {
  commands.wrangler.mockReset();
  if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
  else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
});

describe("selectedAccount", () => {
  it("asks for CLOUDFLARE_ACCOUNT_ID when the identity has several accounts", () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    prints({ accounts: [{ id: ACCOUNT_A, name: "A" }, { id: ACCOUNT_B, name: "B" }] });
    expect(() => selectedAccount("/repo"))
      .toThrow("Set CLOUDFLARE_ACCOUNT_ID when the Wrangler identity belongs to multiple accounts");
    expect(commands.wrangler).toHaveBeenCalledWith("/repo", ".", ["whoami", "--json"], undefined, { quiet: true });
  });

  it("refuses with no account at all", () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    prints({ accounts: [] });
    expect(() => selectedAccount("/repo")).toThrow(/Set CLOUDFLARE_ACCOUNT_ID/);
  });

  it("picks the account CLOUDFLARE_ACCOUNT_ID names among several", () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_B;
    prints({ accounts: [{ id: ACCOUNT_A, name: "A" }, { id: ACCOUNT_B, name: "B" }] });
    expect(selectedAccount("/repo")).toEqual({ id: ACCOUNT_B, name: "B" });
  });

  it("refuses a CLOUDFLARE_ACCOUNT_ID the identity cannot reach, even with one account", () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "b".repeat(32);
    prints({ accounts: [{ id: ACCOUNT_A, name: "A" }] });
    expect(() => selectedAccount("/repo"))
      .toThrow("CLOUDFLARE_ACCOUNT_ID is not available to the current Wrangler identity");
  });

  it("reads accounts from memberships only", () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    prints({ memberships: [{ account_id: ACCOUNT_A, name: "Member" }] });
    expect(selectedAccount("/repo")).toEqual({ id: ACCOUNT_A, name: "Member" });
    prints({ memberships: [{ accountId: ACCOUNT_B }] });
    expect(selectedAccount("/repo")).toEqual({ id: ACCOUNT_B, name: ACCOUNT_B });
  });

  it("reads a direct account_id and does not count it twice", () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    prints({ account_id: ACCOUNT_A });
    expect(selectedAccountId("/repo")).toBe(ACCOUNT_A);
    prints({ accountId: ACCOUNT_A, accounts: [{ id: ACCOUNT_A, name: "A" }] });
    expect(selectedAccount("/repo")).toEqual({ id: ACCOUNT_A, name: "A" });
  });

  it("ignores ids that are not 32 hex characters", () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    prints({
      account_id: "not-an-account",
      accounts: [{ id: "z".repeat(32), name: "Bad" }, { id: ACCOUNT_A.slice(1), name: "Short" }, { id: 42 }, null, "x", { id: ACCOUNT_A, name: "A" }],
    });
    expect(selectedAccount("/repo")).toEqual({ id: ACCOUNT_A, name: "A" });
    // Ignored ids leave no account, which is not a single-account identity.
    prints({ accounts: [{ id: "z".repeat(32) }], account_id: "g".repeat(32) });
    expect(() => selectedAccount("/repo")).toThrow(/Set CLOUDFLARE_ACCOUNT_ID/);
  });
});

describe("listDatabases", () => {
  it("accepts uuid or id and skips rows with no name", () => {
    prints([
      { uuid: "uuid-1", name: "first" },
      { id: "id-2", name: "second" },
      { uuid: "uuid-3" },
      { id: "id-4", name: 4 },
      { name: "no-id" },
      null,
      "row",
    ]);
    expect(listDatabases("/repo")).toEqual([
      { uuid: "uuid-1", name: "first" },
      { uuid: "id-2", name: "second" },
    ]);
    expect(commands.wrangler).toHaveBeenCalledWith("/repo", ".", ["d1", "list", "--json"], undefined, { quiet: true });
  });

  it("refuses output that is not a list", () => {
    prints({ result: [] });
    expect(() => listDatabases("/repo")).toThrow("Wrangler returned an invalid D1 database list");
  });
});

describe("workerExists", () => {
  it("is true for deployments, false for an empty list", () => {
    prints([{ id: "deployment-1" }]);
    expect(workerExists("/repo", "gardener-demo")).toBe(true);
    expect(commands.wrangler).toHaveBeenCalledWith("/repo", ".", [
      "deployments", "list", "--name", "gardener-demo", "--json",
    ], undefined, { quiet: true, allowFailure: true });
    prints([]);
    expect(workerExists("/repo", "gardener-demo")).toBe(false);
    // Anything else on success is read as existing, so a Worker is never overwritten.
    prints({ deployments: [] });
    expect(workerExists("/repo", "gardener-demo")).toBe(true);
  });

  it("is false only when wrangler says the Worker is missing", () => {
    prints("", 1, "✘ [ERROR] A request to the Cloudflare API failed. [code: 10090]");
    expect(workerExists("/repo", "gardener-demo")).toBe(false);
    prints("Worker not found", 1);
    expect(workerExists("/repo", "gardener-demo")).toBe(false);
    prints("", 1, "This Worker does not exist on your account");
    expect(workerExists("/repo", "gardener-demo")).toBe(false);
  });

  it("throws on any other failure", () => {
    prints("", 1, "✘ [ERROR] Authentication error [code: 10000]");
    expect(() => workerExists("/repo", "gardener-demo")).toThrow("Unable to determine whether Worker gardener-demo exists");
  });

  it("throws on invalid JSON from a successful run", () => {
    prints("not json");
    expect(() => workerExists("/repo", "gardener-demo")).toThrow("Wrangler returned invalid deployment data for Worker gardener-demo");
  });
});

describe("workerSecretNames", () => {
  it("returns only the names", () => {
    prints([{ name: "GARDENER_AI_GATEWAY_TOKEN", type: "secret_text" }, { name: 3 }, null, { type: "secret_text" }, { name: "OTHER" }]);
    expect(workerSecretNames("/repo", "gardener-demo")).toEqual(["GARDENER_AI_GATEWAY_TOKEN", "OTHER"]);
    expect(commands.wrangler).toHaveBeenCalledWith("/repo", ".", [
      "secret", "list", "--name", "gardener-demo", "--format", "json",
    ], undefined, { quiet: true });
  });

  it("refuses output that is not a JSON list", () => {
    prints({ secrets: [] });
    expect(() => workerSecretNames("/repo", "gardener-demo")).toThrow("Wrangler returned invalid secret data for Worker gardener-demo");
    prints("not json");
    expect(() => workerSecretNames("/repo", "gardener-demo")).toThrow("Wrangler returned invalid secret data for Worker gardener-demo");
  });
});
