import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readActionsManifest: vi.fn(async () => ({
    schemaVersion: "gardener.actions-installation/v1",
    workspace: "demo-team",
    cloudflare: {
      accountId: "account-1",
      database: { name: "gardener-demo-team", id: "11111111-1111-4111-8111-111111111111" },
      runtimeWorker: "gardener-demo-team-runtime",
      ingressWorker: "gardener-demo-team-runner-ingress",
      ingressOrigin: "https://runner.example.workers.dev",
      runnerAccessBypassAppId: null,
      runtimeConfig: "/private/runtime.json",
      ingressConfig: "/private/ingress.json",
    },
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  })),
  readProjectLock: vi.fn(async () => ({
    tasks: {
      "bug-intake": { bundleHash: "a".repeat(64) },
    },
  })),
  wrangler: vi.fn(),
}));

vi.mock("../src/actions-installation", () => ({
  readActionsManifest: mocks.readActionsManifest,
  readProjectLock: mocks.readProjectLock,
}));
vi.mock("../src/commands", () => ({ wrangler: mocks.wrangler }));

import {
  listActionsRepositories,
  setRepositoryEnabled,
  setTaskEnabled,
} from "../src/actions-operations";

function d1(rows: Array<Record<string, unknown>>) {
  return { status: 0, stdout: JSON.stringify([{ results: rows }]), stderr: "" };
}

function command(args: string[]): string {
  return args[args.indexOf("--command") + 1]!;
}

describe("Actions operational controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.wrangler.mockImplementation((_root: string, _cwd: string, args: string[]) => {
      const sql = command(args);
      if (/SELECT repository_id FROM actions_repository_enrollments/.test(sql)) return d1([{ repository_id: "1379585475" }]);
      if (/SELECT enabled FROM actions_repository_tasks/.test(sql)) return d1([{ enabled: 1 }]);
      if (/SELECT COUNT\(\*\) AS task_count/.test(sql)) return d1([{ task_count: 2, enabled_count: 0 }]);
      if (/SELECT enabled FROM actions_repository_enrollments/.test(sql)) return d1([{ enabled: 0 }]);
      if (/SELECT repository_id,owner_id/.test(sql)) return d1([{ repository_id: "1379585475", enabled: 1 }]);
      return { status: 0, stdout: "", stderr: "" };
    });
  });

  it("enables only the current locked task bundle", async () => {
    await expect(setTaskEnabled({
      workspace: "demo-team",
      repository: "scuffi/demo",
      taskId: "bug-intake",
      repositoryRoot: "/customer/repository",
      sourceRoot: "/trusted/gardener",
      enabled: true,
    })).resolves.toMatchObject({ bundleHash: "a".repeat(64), enabled: true });

    const mutation = mocks.wrangler.mock.calls
      .map((call) => command(call[2]))
      .find((sql) => sql.startsWith("UPDATE actions_repository_tasks"))!;
    expect(mutation).toContain(`bundle_hash='${"a".repeat(64)}'`);
    expect(mutation).not.toContain("bundle_hash IS NULL");
    expect(mutation).not.toContain("actions_control_audit");
  });

  it("disables every bundle version for a task", async () => {
    await expect(setTaskEnabled({
      workspace: "demo-team",
      repository: "scuffi/demo",
      taskId: "bug-intake",
      repositoryRoot: "/customer/repository",
      sourceRoot: "/trusted/gardener",
      enabled: false,
    })).resolves.toMatchObject({ bundleHash: null, enabled: false });

    const mutation = mocks.wrangler.mock.calls
      .map((call) => command(call[2]))
      .find((sql) => sql.startsWith("UPDATE actions_repository_tasks"))!;
    expect(mutation).toContain("task_id='bug-intake'");
    expect(mutation).not.toContain(`bundle_hash='${"a".repeat(64)}'`);
  });

  it("lists repositories and updates repository kill switches", async () => {
    await expect(listActionsRepositories({ workspace: "demo-team", sourceRoot: "/trusted/gardener" }))
      .resolves.toEqual({ repositories: [{ repository_id: "1379585475", enabled: 1 }] });
    await expect(setRepositoryEnabled({
      workspace: "demo-team",
      repository: "scuffi/demo",
      sourceRoot: "/trusted/gardener",
      enabled: false,
    })).resolves.toEqual({ repositoryId: "1379585475", enabled: false });
    expect(mocks.wrangler.mock.calls.map((call) => command(call[2])).join("\n"))
      .toContain("UPDATE actions_repository_enrollments SET enabled=0");
  });
});
