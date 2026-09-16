/// <reference types="node" />
import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  beginGitHubInstallation,
  completeGitHubInstallationCallback,
  finalizeGitHubInstallation,
} from "../src/installations";
import { testDatabase } from "./d1";

const github = vi.hoisted(() => ({ getInstallation: vi.fn(), discoverRepositories: vi.fn() }));
vi.mock("../src/github-client", async (original) => {
  const module = await original<typeof import("../src/github-client")>();
  return {
    ...module,
    getInstallation: github.getInstallation,
    discoverRepositories: github.discoverRepositories,
  };
});

beforeAll(() => {
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
});

describe("owner-bound installation setup", () => {
  it("validates discovered repository contracts before persisting synchronized state", async () => {
    const { sqlite, db } = testDatabase();
    try {
      github.getInstallation.mockResolvedValue({
        id: "7",
        accountId: "50",
        accountLogin: "acme",
        accountType: "Organization",
      });
      github.discoverRepositories.mockResolvedValue([{
        id: "9",
        installationId: "7",
        owner: "acme",
        name: "widgets",
        defaultBranch: "main",
      }]);
      const env = {
        DB: db,
        GITHUB_APP_SLUG: "gardener-team",
        GARDENER_ORIGIN: "https://gardener.example.workers.dev",
      } as Env;
      const request = {
        requestId: "installation_contract_drift",
        requestedBy: { provider: "github" as const, subject: "101", login: "owner" },
      };
      const started = await beginGitHubInstallation(env, request);
      const state = new URL(started.installationUrl).searchParams.get("state");
      await completeGitHubInstallationCallback(env, { installationId: "7", state: state! });

      await expect(finalizeGitHubInstallation(env, request)).rejects.toThrow();
      expect(sqlite.prepare("SELECT COUNT(*) count FROM repositories").get()).toEqual({ count: 0 });
      expect(sqlite.prepare(
        "SELECT sync_generation, sync_lease_token, sync_lease_expires_at FROM installations WHERE id = '7'",
      ).get()).toEqual({ sync_generation: 0, sync_lease_token: null, sync_lease_expires_at: null });
      expect(sqlite.prepare(
        "SELECT finalized_at FROM installation_flows WHERE request_id = ?",
      ).get(request.requestId)).toEqual({ finalized_at: null });
    } finally { sqlite.close(); }
  });

  it("binds finalization to the immutable initiating subject and supports renamed logins", async () => {
    const { sqlite, db } = testDatabase();
    try {
      github.getInstallation.mockResolvedValue({
        id: "7",
        accountId: "50",
        accountLogin: "acme",
        accountType: "Organization",
      });
      github.discoverRepositories.mockResolvedValue([{
        provider: "github",
        id: "9",
        installationId: "7",
        owner: "acme",
        name: "widgets",
        defaultBranch: "main",
      }]);
      const env = {
        DB: db,
        GITHUB_APP_SLUG: "gardener-team",
        GARDENER_ORIGIN: "https://gardener.example.workers.dev",
      } as Env;
      const request = {
        requestId: "installation_1234567890",
        requestedBy: { provider: "github" as const, subject: "101", login: "old-owner" },
      };
      const started = await beginGitHubInstallation(env, request);
      const state = new URL(started.installationUrl).searchParams.get("state");
      expect(state).toMatch(/^install_/);
      expect(sqlite.prepare("SELECT state_hash FROM installation_flows").get())
        .not.toEqual({ state_hash: state });

      await completeGitHubInstallationCallback(env, { installationId: "7", state: state! });
      await expect(finalizeGitHubInstallation(env, {
        ...request,
        requestedBy: { ...request.requestedBy, login: "renamed-owner" },
      })).resolves.toMatchObject({
        installation: { id: "7", accountType: "Organization" },
        repositories: [{ id: "9", installationId: "7" }],
      });
      expect(sqlite.prepare("SELECT COUNT(*) count FROM installations").get())
        .toEqual({ count: 1 });

      await expect(finalizeGitHubInstallation(env, {
        ...request,
        requestedBy: { ...request.requestedBy, subject: "202" },
      })).rejects.toThrow("installation_owner_mismatch");
    } finally { sqlite.close(); }
  });
});
