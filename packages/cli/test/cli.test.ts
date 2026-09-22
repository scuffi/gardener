/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  availableGitHubOperationKinds,
  unavailableGitHubOperationKinds,
} from "@gardener/provider-github";
import { CloudflareAccessRedirectError, fetchJsonEndpoint } from "../src/access";
import { actionsEnrollmentSql, renderActionsCaller } from "../src/actions";
import { parse } from "../src/args";
import { deploymentNames, writeGatewayConfig } from "../src/config";
import { destroyPlan, destroyQualification } from "../src/destroy";
import { defaultSourceRoot } from "../src/distribution";
import { githubAppManifest } from "../src/manifest";
import { gatewayPlan } from "../src/plan";
import { evaluateSmoke } from "../src/smoke";
import { setupPreview } from "../src/setup";
import { statePaths, writePrivateJson, writePrivateText } from "../src/state";
import { terminal } from "../src/terminal";

const originalConfigHome = process.env.GARDENER_CONFIG_HOME;
const originalForceColor = process.env.FORCE_COLOR;
const originalNoColor = process.env.NO_COLOR;
afterEach(() => {
  if (originalConfigHome === undefined) delete process.env.GARDENER_CONFIG_HOME;
  else process.env.GARDENER_CONFIG_HOME = originalConfigHome;
  if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = originalForceColor;
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
});

describe("Gardener CLI", () => {
  it("exposes only the Actions-native local project commands", () => {
    const root = spawnSync(process.execPath, ["dist/cli.js", "--", "help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(root.status).toBe(0);
    expect(root.stdout).toContain("init                         Create");
    expect(root.stdout).toContain("build                        Compile");
    expect(root.stdout).toContain("up                           Init, build, deploy, connect, and verify");
    expect(root.stdout).toContain("qualify                      Run both demo workflows");
    expect(root.stdout).not.toContain("gateway");
    expect(root.stdout).not.toContain("setup");

    const init = spawnSync(process.execPath, ["dist/cli.js", "--", "init", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("gardener init");
    expect(init.stdout).toContain("--demos");

    const build = spawnSync(process.execPath, ["dist/cli.js", "--", "build", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(build.status).toBe(0);
    expect(build.stdout).toContain("gardener build");
    expect(build.stdout).toContain("TaskBundleV1");
  });

  it("uses packaged runtime assets when the CLI distribution contains them", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-distribution-test-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets/gardener-distribution.json"), "{}\n");
    expect(defaultSourceRoot("/customer/repository", pathToFileURL(join(root, "dist/cli.js")).href))
      .toBe(join(root, "assets"));
    expect(defaultSourceRoot("/customer/repository", pathToFileURL(join(root, "no-package/dist/cli.js")).href))
      .toBe("/customer/repository");
  });

  it("renders a deterministic full-SHA-pinned Actions caller and enrollment", () => {
    const workflowRef = `gardener/actions/.github/workflows/triage.yml@${"a".repeat(40)}`;
    const audience = "https://runner.example.workers.dev";
    const taskBundleHash = "b".repeat(64);
    expect(renderActionsCaller({ workflowRef, audience, taskBundleHash })).toBe(`name: Gardener triage

on:
  issues:
    types: [opened]

permissions: {}

jobs:
  gardener:
    if: \${{ contains(github.event.issue.labels.*.name, 'gardener-test') }}
    permissions:
      contents: read
      issues: write
      id-token: write
    uses: ${workflowRef}
    with:
      harness-url: ${audience}
      task-bundle-hash: ${taskBundleHash}
`);
    const sql = actionsEnrollmentSql({
      repositoryId: "1374842705",
      ownerId: "45369682",
      ownerLogin: "owner",
      repositoryName: "repository",
      visibility: "private",
      workflowRef,
      audience,
    });
    expect(sql).toContain("ON CONFLICT(repository_id) DO UPDATE");
    expect(sql).toContain(`'${workflowRef}'`);
    expect(sql).toContain("enabled) VALUES");
    expect(sql).not.toContain("oidc_audience=excluded.oidc_audience,enabled=1");
    expect(() => renderActionsCaller({ workflowRef: "gardener/actions/.github/workflows/triage.yml@main", audience, taskBundleHash }))
      .toThrow(/full-sha/i);
    expect(() => renderActionsCaller({ workflowRef, audience: `${audience}/path`, taskBundleHash }))
      .toThrow(/HTTPS origin/);
  });

  it("uses restrained TTY colours and respects NO_COLOR", () => {
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;
    expect(terminal.title("Gardener setup")).toContain("\u001b[1m\u001b[32m");
    expect(terminal.value("agents")).toContain("\u001b[36m");
    process.env.NO_COLOR = "";
    expect(terminal.title("Gardener setup")).toBe("Gardener setup");
    expect(terminal.value("agents")).toBe("agents");
  });

  it("explains Cloudflare Access redirects instead of parsing HTML as JSON", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("<!doctype html>", {
      status: 302,
      headers: {
        location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/example",
        "content-type": "text/html",
      },
    });
    try {
      await expect(fetchJsonEndpoint(
        "https://gardener.example.workers.dev/health",
        {},
        { label: "Gardener health" },
      )).rejects.toBeInstanceOf(CloudflareAccessRedirectError);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    expect(Object.fromEntries(parse(["--drills", "--drills-only"]).flags)).toEqual({
      drills: true,
      "drills-only": true,
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
    expect(manifest.default_events).not.toContain("installation");
    expect(manifest.default_events).not.toContain("installation_repositories");
    expect(manifest.default_events).toContain("issues");
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
