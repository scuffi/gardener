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
  pullRequestPermissionWarningsFor,
  renderRuntimeConfig,
  upgradeActions,
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

  it("fails upgrade before provisioning when the workspace does not exist", async () => {
    process.env.GARDENER_CONFIG_HOME = await mkdtemp(join(tmpdir(), "gardener-missing-upgrade-"));
    await expect(upgradeActions({ workspace: "missing-team", sourceRoot: "." }))
      .rejects.toThrow(/No Actions installation exists/);
  });

  it("preserves a task kill-switch while enrolling only the current bundle", () => {
    const sql = actionsRepositoryTaskEnrollmentSql({
      repositoryId: "1379585475",
      taskId: "bug-intake",
      bundleHash: "a".repeat(64),
      sourcePath: ".gardener/tasks/bug-intake/TASK.md",
    });
    expect(sql).toContain("SELECT MAX(o.enabled)");
    expect(sql).toContain(`bundle_hash,task_id,source_path,enabled) SELECT '1379585475','${"a".repeat(64)}','bug-intake'`);
    expect(sql).not.toContain("enabled=1");
  });

  it("re-enables a reverted bundle only when its task is not disabled", async () => {
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
      // Reconnecting an unchanged checkout keeps the task enabled.
      connect("b");
      expect(rows()).toBe("a:0 b:1");
      connect("a");
      expect(rows()).toBe("a:1 b:0");
      // task disable sets every row to 0; connecting does not undo it.
      db.exec("UPDATE actions_repository_tasks SET enabled=0");
      connect("b");
      connect("b");
      expect(rows()).toBe("a:0 b:0");
      // task enable enables only the lock's bundle, and connecting keeps it.
      db.exec(`UPDATE actions_repository_tasks SET enabled=1 WHERE bundle_hash='${"b".repeat(64)}'`);
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
    // Each bundle names its model, so the runtime carries no model setting.
    expect(runtime).not.toHaveProperty("vars");
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
