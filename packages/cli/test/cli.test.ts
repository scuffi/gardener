/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  availableGitHubOperationKinds,
  unavailableGitHubOperationKinds,
} from "@gardener/provider-github";
import { parse } from "../src/args";
import { deploymentNames, writeGatewayConfig } from "../src/config";
import { destroyPlan, destroyQualification } from "../src/destroy";
import { githubAppManifest } from "../src/manifest";
import { gatewayPlan } from "../src/plan";
import { evaluateSmoke } from "../src/smoke";
import { setupPreview } from "../src/setup";
import { statePaths, writePrivateJson, writePrivateText } from "../src/state";

const originalConfigHome = process.env.GARDENER_CONFIG_HOME;
afterEach(() => {
  if (originalConfigHome === undefined) delete process.env.GARDENER_CONFIG_HOME;
  else process.env.GARDENER_CONFIG_HOME = originalConfigHome;
});

describe("Gardener Gateway CLI", () => {
  it("runs the bundled Node entrypoint with pnpm's forwarded separator", () => {
    const root = spawnSync(process.execPath, ["dist/cli.js", "--", "help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(root.status).toBe(0);
    expect(root.stdout).toContain("setup                        Plan, provision");

    const setup = spawnSync(process.execPath, ["dist/cli.js", "--", "setup", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("gardener setup");
    expect(setup.stdout).toContain("--personal");

    const gateway = spawnSync(process.execPath, ["dist/cli.js", "--", "gateway", "help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(gateway.status).toBe(0);
    expect(gateway.stdout).toContain("plan                         Build");
    expect(gateway.stdout).toContain("destroy                      Delete");
  });

  it("parses explicit resumable command options", () => {
    const result = parse([
      "delivery-1",
      "--workspace", "team-one",
      "--yes",
      "--owner-id", "101",
    ]);
    expect(result.positional).toEqual(["delivery-1"]);
    expect(Object.fromEntries(result.flags)).toEqual({
      workspace: "team-one",
      yes: true,
      "owner-id": "101",
    });
    expect(() => parse(["--workspace"])).toThrow("Missing value");
    expect(() => parse(["--yes", "--yes"])).toThrow("duplicate");
  });

  it("derives isolated Cloudflare resource names and reciprocal bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-config-test-"));
    const names = deploymentNames("team-one");
    expect(names).toMatchObject({
      gardenerWorker: "gardener-team-one",
      gatewayWorker: "gardener-team-one-github-gateway",
      gardenerDatabase: "gardener-team-one",
      gatewayDatabase: "gardener-team-one-github-gateway",
    });
    const configPath = await writeGatewayConfig({
      repositoryRoot: root,
      workspace: "team-one",
      gatewayOrigin: "https://gateway.example.workers.dev",
      gardenerOrigin: "https://gardener.example.workers.dev",
      linked: true,
      gatewayDatabaseId: "11111111-1111-4111-8111-111111111111",
      cloudflareAccountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config).toMatchObject({
      name: names.gatewayWorker,
      account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      vars: { GARDENER_WORKSPACE_ID: "team-one" },
      d1_databases: [{
        database_name: names.gatewayDatabase,
        database_id: "11111111-1111-4111-8111-111111111111",
      }],
      services: [{ service: names.gardenerWorker, entrypoint: "GardenerGitHubEntrypoint" }],
    });
  });

  it("produces an exact secret-free setup preview", () => {
    const preview = setupPreview({
      workspace: "team-one",
      cloudflareAccountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      permanentOwner: { id: "101", login: "owner" },
      githubAppOwner: { kind: "personal", expectedLogin: "owner" },
    });
    expect(preview).toMatchObject({
      schemaVersion: "gardener-setup/v1",
      workspace: "team-one",
      permanentOwner: { id: "101", login: "owner" },
      resources: {
        gardenerWorker: "gardener-team-one",
        gatewayWorker: "gardener-team-one-github-gateway",
      },
      leavesGardenerPaused: true,
    });
    expect(JSON.stringify(preview)).not.toMatch(
      /GITHUB_CLIENT_SECRET|GITHUB_APP_PRIVATE_KEY|GATEWAY_OPERATOR_TOKEN|BEGIN PRIVATE KEY/,
    );
  });

  it("produces non-mutating topology and qualification-only destroy plans", () => {
    const plan = gatewayPlan("qual-team-one");
    expect(plan).toMatchObject({
      workspace: "qual-team-one",
      mutatesRemoteResources: false,
      resources: {
        workers: [
          "gardener-qual-team-one-github-gateway",
          "gardener-qual-team-one",
        ],
      },
    });
    expect(destroyPlan("qual-team-one")).toMatchObject({
      qualificationOnly: true,
      manualGitHubCleanupRequired: true,
    });
  });

  it("fails smoke reports for RPC drift, capability drift, or delivery backlog", () => {
    const capabilities = {
      contractVersion: "github-gateway/v1" as const,
      operations: [
        ...availableGitHubOperationKinds,
        ...unavailableGitHubOperationKinds,
      ].map((kind) => ({
        kind,
        available: availableGitHubOperationKinds.includes(
          kind as (typeof availableGitHubOperationKinds)[number],
        ),
      })),
    };
    const gateway = {
      contractVersion: "github-gateway/v1" as const,
      ready: true,
      database: true,
      githubApp: true,
      gardenerBinding: true,
    };
    const diagnostics = {
      health: gateway,
      capabilities,
      failedDeliveries: [],
      staleDeliveries: [],
    };
    expect(evaluateSmoke("qual-team-one", gateway, diagnostics, {
      ok: true,
      githubGateway: { configured: true, ready: true },
      agentRuntime: { enabled: true, status: "bounded-issue-comment-v3" },
    })).toMatchObject({
      passed: true,
      capabilityCounts: { total: 29, available: 12, unavailable: 17 },
    });
    expect(evaluateSmoke("qual-team-one", gateway, {
      ...diagnostics,
      health: { ...gateway, gardenerBinding: false },
    }, {
      ok: true,
      githubGateway: { configured: true, ready: true },
    }).passed).toBe(false);
  });

  it("refuses teardown for ordinary and non-qual workspace checkpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gardener-destroy-test-"));
    process.env.GARDENER_CONFIG_HOME = directory;
    const paths = statePaths("team-one");
    await writePrivateJson(paths.checkpoint, {
      version: 2,
      workspace: "team-one",
      step: "complete",
      purpose: "workspace",
      owner: { id: "101", login: "owner" },
      updatedAt: new Date().toISOString(),
    });
    await expect(destroyQualification({
      workspace: "team-one",
      execute: false,
    })).rejects.toThrow("restricted");
  });

  it("builds a private app manifest with exact callback origins", () => {
    const manifest = githubAppManifest(
      "Gardener team-one abc123",
      "https://gardener.example.workers.dev",
      "https://gateway.example.workers.dev",
      "http://127.0.0.1:1234/callback",
    );
    expect(manifest).toMatchObject({
      name: "Gardener team-one abc123",
      public: false,
      callback_urls: ["https://gateway.example.workers.dev/oauth/github/callback"],
      setup_url: "https://gateway.example.workers.dev/installations/github/callback",
      hook_attributes: { url: "https://gateway.example.workers.dev/webhooks/github" },
      default_permissions: {
        metadata: "read",
        contents: "write",
        issues: "write",
        pull_requests: "write",
      },
    });
    expect(manifest.default_events).toContain("installation_repositories");
  });

  it("writes local setup state and operator tokens with owner-only modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gardener-cli-test-"));
    process.env.GARDENER_CONFIG_HOME = directory;
    const paths = statePaths("team-one");
    await writePrivateJson(paths.checkpoint, {
      version: 2,
      workspace: "team-one",
      step: "new",
      purpose: "workspace",
    });
    await writePrivateText(paths.operatorToken, "secret\n");
    expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.checkpoint)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.operatorToken)).mode & 0o777).toBe(0o600);
    expect(await readFile(paths.operatorToken, "utf8")).toBe("secret\n");
    await writePrivateText(paths.operatorToken, "replacement\n");
    expect(await readFile(paths.operatorToken, "utf8")).toBe("replacement\n");
  });
});
