/// <reference types="node" />
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The installation is read from Cloudflare, so the account, D1 and wrangler
// calls are stubbed; each test says what the account holds.
const cloudflare = vi.hoisted(() => ({
  databases: [] as Array<{ name: string; uuid: string }>,
  facts: null as Array<{ key: string; value: string }> | null,
  tables: [] as string[],
  workerExists: true,
  secrets: [] as string[],
  wrangler: vi.fn(),
}));
vi.mock("../src/provision", () => ({
  listDatabases: () => cloudflare.databases,
  selectedAccountId: () => "account-1",
  workerExists: () => cloudflare.workerExists,
  workerSecretNames: () => cloudflare.secrets,
}));
vi.mock("../src/actions-d1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/actions-d1")>()),
  isolatedWranglerDirectory: () => "/isolated",
  queryD1IfTableExists: () => cloudflare.facts,
  executeD1: vi.fn(),
  queryD1: vi.fn(() => cloudflare.tables.map((name) => ({ name }))),
}));
vi.mock("../src/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commands")>()),
  wrangler: cloudflare.wrangler,
  runCommand: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

import {
  actionsDeploymentHash,
  actionsRepositoryTaskEnrollmentSql,
  actionsResourceNames,
  cliVersion,
  compareVersions,
  deployActions,
  ensurePublicRuntime,
  installationFactsSql,
  parseAiGateway,
  pullRequestPermissionWarningsFor,
  type AiGateway,
  renderRuntimeConfig,
  resolveInstallation,
  upgradeActions,
} from "../src/actions-installation";
import { DEFAULT_WORKFLOW_REF } from "../src/project";

const originalToken = process.env.CLOUDFLARE_API_TOKEN;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  cloudflare.databases = [];
  cloudflare.facts = null;
  cloudflare.tables = [];
  cloudflare.workerExists = true;
  cloudflare.secrets = [];
  if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = originalToken;
});

const PROD_DATABASE = { name: "gardener-demo-team", uuid: "11111111-1111-4111-8111-111111111111" };

describe("Actions-native installation topology", () => {
  it("derives isolated deterministic Cloudflare names", () => {
    expect(actionsResourceNames("demo-team")).toEqual({
      database: "gardener-demo-team",
      runtimeWorker: "gardener-demo-team",
    });
    expect(() => actionsResourceNames("Invalid Workspace")).toThrow();
  });

  it("fails upgrade before provisioning when the workspace does not exist", async () => {
    await expect(upgradeActions({ workspace: "missing-team", sourceRoot: "." }))
      .rejects.toThrow(/No Gardener installation named missing-team/);
    expect(cloudflare.wrangler).not.toHaveBeenCalled();
  });

  it("derives an installation from the account and the facts its deploy recorded", async () => {
    cloudflare.databases = [PROD_DATABASE];
    cloudflare.facts = [
      { key: "runtime_origin", value: "https://gardener-demo-team.example.workers.dev" },
      { key: "cli_version", value: "0.1.2" },
      { key: "deployment_hash", value: "a".repeat(64) },
    ];
    await expect(resolveInstallation("demo-team")).resolves.toMatchObject({
      workspace: "demo-team",
      cloudflare: {
        accountId: "account-1",
        database: { name: "gardener-demo-team", id: PROD_DATABASE.uuid },
        runtimeWorker: "gardener-demo-team",
        runtimeOrigin: "https://gardener-demo-team.example.workers.dev",
      },
      cliVersion: "0.1.2",
      deploymentHash: "a".repeat(64),
    });
  });

  it("asks for an upgrade when a runtime predates recorded installation facts", async () => {
    cloudflare.databases = [PROD_DATABASE];
    cloudflare.facts = null;
    await expect(resolveInstallation("demo-team")).rejects.toThrow(/deployed by an older CLI/);
    await expect(resolveInstallation("other-team")).rejects.toThrow(/No Gardener installation named other-team/);
  });

  it("never replaces a runtime deployed by a newer CLI", async () => {
    cloudflare.databases = [PROD_DATABASE];
    cloudflare.facts = [{ key: "cli_version", value: "99.0.0" }];
    const version = await cliVersion();
    await expect(deployActions({ workspace: "demo-team", sourceRoot: "." }))
      .rejects.toThrow(`runs 99.0.0, newer than this CLI (${version})`);
    expect(cloudflare.wrangler).not.toHaveBeenCalled();
  });

  it("adopts only an empty or Gardener database of the workspace name", async () => {
    cloudflare.databases = [PROD_DATABASE];
    cloudflare.tables = ["_cf_KV", "d1_migrations", "users", "orders"];
    await expect(deployActions({ workspace: "demo-team", sourceRoot: "." }))
      .rejects.toThrow(/exists but is not a Gardener installation/);
    expect(cloudflare.wrangler).not.toHaveBeenCalled();
  });

  it("refuses a Worker of the workspace name that has no database", async () => {
    cloudflare.workerExists = true;
    await expect(deployActions({ workspace: "demo-team", sourceRoot: "." }))
      .rejects.toThrow(/exists without a gardener-demo-team database/);
    expect(cloudflare.wrangler).not.toHaveBeenCalled();
  });

  it("needs the gateway token before touching Cloudflare", async () => {
    cloudflare.databases = [PROD_DATABASE];
    cloudflare.facts = [{ key: "cli_version", value: "0.0.1" }, { key: "runtime_origin", value: "https://x.workers.dev" }];
    const aiGateway = { accountId: "acct", gatewayId: "gw", project: "p" };
    await expect(deployActions({ workspace: "demo-team", sourceRoot: ".", aiGateway }))
      .rejects.toThrow(/needs its token: set GARDENER_AI_GATEWAY_TOKEN/);
    // A kept gateway also needs a token, in the environment or already on the Worker.
    cloudflare.facts.push({ key: "ai_gateway", value: "acct/gw" });
    await expect(deployActions({ workspace: "demo-team", sourceRoot: "." }))
      .rejects.toThrow(/needs its token/);
    expect(cloudflare.wrangler).not.toHaveBeenCalled();
  });

  it("ignores an exported token when the installation has no gateway", async () => {
    cloudflare.databases = [PROD_DATABASE];
    cloudflare.facts = [{ key: "cli_version", value: "0.0.1" }, { key: "ai_gateway", value: "acct/gw" }];
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The deploy stops later against the stubs; the gateway checks come first.
    const outcome = await deployActions({ workspace: "demo-team", sourceRoot: ".", aiGateway: "off", aiGatewayToken: "t" })
      .catch((error: unknown) => error);
    expect(String(outcome)).not.toMatch(/AI Gateway|GARDENER_AI_GATEWAY_TOKEN/);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/GARDENER_AI_GATEWAY_TOKEN is set, but demo-team has no AI Gateway/));
    for (const [, , args, input] of cloudflare.wrangler.mock.calls) {
      expect(args).not.toContain("--secrets-file");
      expect(input).toBeUndefined();
    }
    warn.mockRestore();
  });

  it("records every deploy fact the migrated schema allows", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { readFileSync, readdirSync } = await import("node:fs");
    const db = new DatabaseSync(":memory:");
    const migrations = new URL("../../../apps/gardener/migrations/", import.meta.url);
    const files = readdirSync(migrations).sort();
    // Facts written before the gateway migration survive it.
    for (const file of files.filter((name) => name < "0004")) db.exec(readFileSync(new URL(file, migrations), "utf8"));
    db.exec("INSERT INTO actions_installation(key,value) VALUES ('cli_version','0.1.5');");
    for (const file of files.filter((name) => name >= "0004")) db.exec(readFileSync(new URL(file, migrations), "utf8"));
    const facts = {
      runtime_origin: "https://x.workers.dev",
      cli_version: "0.1.6",
      deployment_hash: "a".repeat(64),
      deployed_at: "2026-09-30T00:00:00.000Z",
      ai_gateway: "acct/gw",
      ai_gateway_project: "agents-team-gardener",
    };
    db.exec(installationFactsSql(facts));
    db.exec(installationFactsSql({ ...facts, ai_gateway: "", ai_gateway_project: "" }));
    const rows = db.prepare("SELECT key, value FROM actions_installation ORDER BY key").all();
    expect(Object.fromEntries(rows.map((row) => [row.key, row.value]))).toEqual({ ...facts, ai_gateway: "", ai_gateway_project: "" });
  });

  it("parses --ai-gateway", () => {
    expect(parseAiGateway("acct-1/project-gateway", "agents-team-gardener"))
      .toEqual({ accountId: "acct-1", gatewayId: "project-gateway", project: "agents-team-gardener" });
    expect(parseAiGateway("acct/gw", undefined)).toEqual({ accountId: "acct", gatewayId: "gw", project: null });
    expect(parseAiGateway("off", undefined)).toBe("off");
    expect(() => parseAiGateway("off", "p")).toThrow(/needs a gateway/);
    for (const bad of ["acct", "acct/", "/gw", "a/b/c", "a b/gw", "acct/gw?x"]) {
      expect(() => parseAiGateway(bad, undefined)).toThrow(/must be <account-id>\/<gateway-id>/);
    }
    expect(() => parseAiGateway("acct/gw", "has space")).toThrow(/--ai-gateway-project must be/);
  });

  it("renders the gateway as vars, never the token", () => {
    const render = (aiGateway: AiGateway | null) => JSON.parse(renderRuntimeConfig({
      names: actionsResourceNames("demo-team"),
      databaseId: "11111111-1111-4111-8111-111111111111",
      sourceRoot: "/trusted/gardener",
      workspace: "demo-team",
      aiGateway,
    })).vars;
    expect(render({ accountId: "acct", gatewayId: "gw", project: "agents-team-gardener" })).toEqual({
      GARDENER_RELEASE_WORKFLOW_REF: DEFAULT_WORKFLOW_REF,
      GARDENER_AI_GATEWAY_ACCOUNT_ID: "acct",
      GARDENER_AI_GATEWAY_ID: "gw",
      GARDENER_AI_GATEWAY_PROJECT: "agents-team-gardener",
    });
    expect(render({ accountId: "acct", gatewayId: "gw", project: null })).not.toHaveProperty("GARDENER_AI_GATEWAY_PROJECT");
    expect(render(null)).toEqual({ GARDENER_RELEASE_WORKFLOW_REF: DEFAULT_WORKFLOW_REF });
  });

  it("compares release versions numerically", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.2", "0.1.2")).toBe(0);
    expect(compareVersions("0.1.2-rc.1", "0.1.2")).toBe(0);
    expect(compareVersions("0.2.0", "1.0.0")).toBe(-1);
  });

  it("enables exactly the checkout's bundles, so reverts and restored tasks come back", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { readFileSync, readdirSync } = await import("node:fs");
    const db = new DatabaseSync(":memory:");
    const migrations = new URL("../../../apps/gardener/migrations/", import.meta.url);
    for (const file of readdirSync(migrations).sort()) db.exec(readFileSync(new URL(file, migrations), "utf8"));
    db.prepare("INSERT INTO actions_repository_enrollments(repository_id,owner_id,owner_login,repository_name,visibility,plan_job_workflow_ref,oidc_audience) VALUES (?,?,?,?,?,?,?)")
      .run("1", "2", "o", "r", "public", "ref", "aud");
    for (const hash of ["a", "b"]) {
      db.prepare("INSERT INTO actions_task_bundles(bundle_hash,task_id,bundle_json) VALUES (?,?,?)").run(hash.repeat(64), "t", "{}");
    }
    const base = { repositoryId: "1", taskId: "t", sourcePath: ".gardener/tasks/t/TASK.md" };
    // One connect: enroll the checkout's bundle, then retire the rest, as connectActions does.
    const connect = (hash: string) => {
      db.exec(actionsRepositoryTaskEnrollmentSql({ ...base, bundleHash: hash.repeat(64) }));
      db.exec(`UPDATE actions_repository_tasks SET enabled=0 WHERE bundle_hash<>'${hash.repeat(64)}'`);
    };
    const rows = () => db.prepare("SELECT substr(bundle_hash,1,1) AS h,enabled FROM actions_repository_tasks ORDER BY h").all()
      .map((row) => `${String(row.h)}:${String(row.enabled)}`).join(" ");
    try {
      connect("a");
      connect("b");
      expect(rows()).toBe("a:0 b:1");
      connect("b");
      expect(rows()).toBe("a:0 b:1");
      connect("a");
      expect(rows()).toBe("a:1 b:0");
      // A task deleted (every row stopped) and later restored comes back.
      db.exec("UPDATE actions_repository_tasks SET enabled=0");
      connect("b");
      expect(rows()).toBe("a:0 b:1");
    } finally { db.close(); }
  });

  it("creates an exact-host Access bypass only when the account intercepts the runtime", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/health")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
        });
      }
      if (url.includes("/access/apps?")) return Response.json({ success: true, result: [] });
      if (url.endsWith("/access/apps") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          domain: "runner.example.workers.dev",
          type: "self_hosted",
          policies: [{ decision: "bypass", include: [{ everyone: {} }] }],
        });
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
        return Response.json({ success: true, result: { id: "access-app-1" } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    await expect(ensurePublicRuntime({
      accountId: "account-1",
      workspace: "demo-team",
      runtimeOrigin: "https://runner.example.workers.dev",
      existingAppId: null,
    }, 0)).resolves.toBe("access-app-1");
  });

  it("hashes the exact deployable runtime and migrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-actions-deployment-"));
    await mkdir(join(root, "apps/gardener/dist/gardener_runtime"), { recursive: true });
    await mkdir(join(root, "apps/gardener/migrations"), { recursive: true });
    await writeFile(join(root, "apps/gardener/dist/gardener_runtime/index.js"), "export default 1;\n");
    await writeFile(join(root, "apps/gardener/migrations/0001.sql"), "SELECT 1;\n");
    const first = await actionsDeploymentHash(root);
    expect(await actionsDeploymentHash(root)).toBe(first);
    await writeFile(join(root, "apps/gardener/dist/gardener_runtime/index.js"), "export default 2;\n");
    expect(await actionsDeploymentHash(root)).not.toBe(first);
  });

  it("renders one narrow public runtime Worker", () => {
    const sourceRoot = "/trusted/gardener";
    const names = actionsResourceNames("demo-team");
    const runtime = JSON.parse(renderRuntimeConfig({
      names,
      databaseId: "11111111-1111-4111-8111-111111111111",
      sourceRoot,
      workspace: "demo-team",
    })) as Record<string, any>;
    expect(runtime.name).toBe(names.runtimeWorker);
    expect(runtime.main).toBe(join(sourceRoot, "apps/gardener/dist/gardener_runtime/index.js"));
    expect(runtime.workers_dev).toBe(true);
    expect(runtime.d1_databases).toEqual([expect.objectContaining({
      database_name: names.database,
      database_id: "11111111-1111-4111-8111-111111111111",
    })]);
    // Each bundle names its model, so the runtime's only setting is its release.
    expect(runtime.vars).toEqual({ GARDENER_RELEASE_WORKFLOW_REF: DEFAULT_WORKFLOW_REF });
    expect(runtime).not.toHaveProperty("assets");
    expect(runtime).not.toHaveProperty("triggers");
    expect(runtime.d1_databases[0].migrations_dir).toBe(join(sourceRoot, "apps/gardener/migrations"));
    expect(runtime.durable_objects.bindings).toEqual([
      { name: "RUNNER_SESSIONS", class_name: "TaskRunnerSession" },
      { name: "FLUE_GARDENER_TASK_HARNESS_AGENT", class_name: "FlueGardenerTaskHarnessAgent" },
    ]);
    expect(JSON.stringify(runtime)).not.toMatch(/Gateway|ComputerWorkspace|GardenerGitHubEntrypoint|FlueGardenerHarnessAgent/);

    expect(runtime).not.toHaveProperty("services");
  });
});

describe("pull request permission check", () => {
  const repositories = [
    { repositoryId: "1", repository: "acme/opens", kinds: ["pull_request.open_draft", "issue.comment.create"] },
    { repositoryId: "2", repository: "acme/reviews", kinds: ["pull_request.review.submit"] },
    { repositoryId: "3", repository: "acme/allowed", kinds: ["pull_request.open_draft"] },
    { repositoryId: "4", repository: "acme/unreadable", kinds: ["pull_request.open_draft"] },
  ];
  const settings: Record<string, unknown> = {
    "1": { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
    "2": { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
    "3": { default_workflow_permissions: "read", can_approve_pull_request_reviews: true },
  };

  it("warns for each repository whose tasks need the setting while it is off or unreadable", () => {
    const read = vi.fn((repositoryId: string) => {
      if (!(repositoryId in settings)) throw new Error("HTTP 403");
      return settings[repositoryId];
    });
    const warnings = pullRequestPermissionWarningsFor(repositories, read);
    expect(read.mock.calls.map(([id]) => id)).toEqual(["1", "2", "3", "4"]);
    expect(warnings.map((warning) => warning.repository)).toEqual(["acme/opens", "acme/reviews", "acme/unreadable"]);
    expect(warnings[0]?.message).toMatch(/acme\/opens has tasks that open pull requests, but "Allow GitHub Actions to create and approve pull requests .*" is off/);
    expect(warnings[1]?.message).toContain("approve pull requests");
    expect(warnings[2]?.message).toMatch(/could not confirm/);
  });

  it("stays quiet when no repository needs it", () => {
    expect(pullRequestPermissionWarningsFor([], () => { throw new Error("not called"); })).toEqual([]);
  });
});
