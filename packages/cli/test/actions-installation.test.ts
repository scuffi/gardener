/// <reference types="node" />
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionsDeploymentHash,
  actionsInstallationDirectory,
  actionsRepositoryTaskEnrollmentSql,
  actionsResourceNames,
  destroyActions,
  ensurePublicRuntime,
  renderRuntimeConfig,
} from "../src/actions-installation";

const originalToken = process.env.CLOUDFLARE_API_TOKEN;
const originalConfigHome = process.env.GARDENER_CONFIG_HOME;
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = originalToken;
  if (originalConfigHome === undefined) delete process.env.GARDENER_CONFIG_HOME;
  else process.env.GARDENER_CONFIG_HOME = originalConfigHome;
});

describe("Actions-native installation topology", () => {
  it("derives isolated deterministic Cloudflare names", () => {
    expect(actionsResourceNames("demo-team")).toEqual({
      database: "gardener-demo-team",
      runtimeWorker: "gardener-demo-team",
    });
    expect(() => actionsResourceNames("Invalid Workspace")).toThrow();
  });

  it("preserves a task kill-switch while enrolling only the current bundle", () => {
    const sql = actionsRepositoryTaskEnrollmentSql({
      repositoryId: "1379585475",
      taskId: "bug-intake",
      bundleHash: "a".repeat(64),
      sourcePath: ".gardener/tasks/bug-intake/TASK.md",
    });
    expect(sql).toContain("SELECT MAX(enabled)");
    expect(sql).toContain(`bundle_hash,task_id,source_path,enabled) SELECT '1379585475','${"a".repeat(64)}','bug-intake'`);
    expect(sql).not.toContain("enabled=1");
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
    await mkdir(join(root, "apps/gardener/dist/gardener_actions_v1_runtime"), { recursive: true });
    await mkdir(join(root, "apps/gardener/migrations-actions"), { recursive: true });
    await writeFile(join(root, "apps/gardener/dist/gardener_actions_v1_runtime/index.js"), "export default 1;\n");
    await writeFile(join(root, "apps/gardener/migrations-actions/0001.sql"), "SELECT 1;\n");
    const first = await actionsDeploymentHash(root);
    expect(await actionsDeploymentHash(root)).toBe(first);
    await writeFile(join(root, "apps/gardener/dist/gardener_actions_v1_runtime/index.js"), "export default 2;\n");
    expect(await actionsDeploymentHash(root)).not.toBe(first);
  });

  it("writes a stable manifest-bound teardown intent before permitting deletion", async () => {
    process.env.GARDENER_CONFIG_HOME = await mkdtemp(join(tmpdir(), "gardener-actions-down-"));
    const directory = actionsInstallationDirectory("demo-team");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "installation.json"), JSON.stringify({
      schemaVersion: "gardener.actions-installation/v2",
      workspace: "demo-team",
      cloudflare: {
        accountId: "account-1",
        database: { name: "gardener-demo-team", id: "11111111-1111-4111-8111-111111111111" },
        runtimeWorker: "gardener-demo-team",
        runtimeOrigin: "https://runner.example.workers.dev",
        runnerAccessBypassAppId: null,
        runtimeConfig: "/private/runtime.json",
      },
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    }));

    const first = await destroyActions({ workspace: "demo-team", sourceRoot: ".", execute: false });
    const second = await destroyActions({ workspace: "demo-team", sourceRoot: ".", execute: false });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ destroyed: false, intentDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(destroyActions({
      workspace: "demo-team",
      sourceRoot: ".",
      execute: true,
      confirm: "wrong",
    })).rejects.toThrow(`--confirm ${first.intentDigest}`);

    const intentPath = join(directory, "teardown-intent.json");
    const expired = JSON.parse(await readFile(intentPath, "utf8")) as Record<string, unknown>;
    expired.createdAt = "2020-01-01T00:00:00.000Z";
    await writeFile(intentPath, JSON.stringify(expired));
    await expect(destroyActions({
      workspace: "demo-team",
      sourceRoot: ".",
      execute: true,
      confirm: first.intentDigest,
    })).rejects.toThrow(/intent expired/i);
    expect((await destroyActions({ workspace: "demo-team", sourceRoot: ".", execute: false })).intentDigest)
      .not.toBe(first.intentDigest);
  });

  it("keeps a teardown path for retired two-Worker manifests", async () => {
    process.env.GARDENER_CONFIG_HOME = await mkdtemp(join(tmpdir(), "gardener-legacy-down-"));
    const directory = actionsInstallationDirectory("legacy-team");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "installation.json"), JSON.stringify({
      schemaVersion: "gardener.actions-installation/v1",
      workspace: "legacy-team",
      cloudflare: {
        accountId: "account-1",
        database: { name: "gardener-legacy-team", id: "11111111-1111-4111-8111-111111111111" },
        runtimeWorker: "gardener-legacy-team-runtime",
        ingressWorker: "gardener-legacy-team-runner-ingress",
        ingressOrigin: "https://legacy-runner.example.workers.dev",
        runnerAccessBypassAppId: null,
        runtimeConfig: "/private/runtime.json",
        ingressConfig: "/private/ingress.json",
      },
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    }));

    await expect(destroyActions({ workspace: "legacy-team", sourceRoot: ".", execute: false }))
      .resolves.toMatchObject({ destroyed: false });
    const intent = JSON.parse(await readFile(join(directory, "teardown-intent.json"), "utf8"));
    expect(intent).toMatchObject({
      schemaVersion: "gardener.actions-teardown-intent/v2",
      resources: {
        runtimeWorker: "gardener-legacy-team-runtime",
        legacyIngressWorker: "gardener-legacy-team-runner-ingress",
      },
    });
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
    expect(runtime.main).toBe(join(sourceRoot, "apps/gardener/dist/gardener_actions_v1_runtime/index.js"));
    expect(runtime.workers_dev).toBe(true);
    expect(runtime.d1_databases).toEqual([expect.objectContaining({
      database_name: names.database,
      database_id: "11111111-1111-4111-8111-111111111111",
    })]);
    expect(runtime.vars).toMatchObject({
      GARDENER_WORKSPACE_ID: "demo-team",
      GARDENER_DEPLOYMENT_MODE: "actions-v1",
      LOCAL_DEV_BYPASS: "false",
    });
    expect(runtime).not.toHaveProperty("assets");
    expect(runtime).not.toHaveProperty("triggers");
    expect(runtime.d1_databases[0].migrations_dir).toBe(join(sourceRoot, "apps/gardener/migrations-actions"));
    expect(runtime.durable_objects.bindings).toEqual([
      { name: "RUNNER_SESSIONS", class_name: "TaskRunnerSession" },
      { name: "FLUE_GARDENER_TASK_HARNESS_AGENT", class_name: "FlueGardenerTaskHarnessAgent" },
    ]);
    expect(JSON.stringify(runtime)).not.toMatch(/Gateway|ComputerWorkspace|GardenerGitHubEntrypoint|FlueGardenerHarnessAgent/);

    expect(runtime).not.toHaveProperty("services");
  });
});
