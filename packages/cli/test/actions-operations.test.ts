import { readFileSync, rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveInstallation: vi.fn(async () => ({
    workspace: "demo-team",
    cloudflare: {
      accountId: "account-1",
      database: { name: "gardener-demo-team", id: "11111111-1111-4111-8111-111111111111" },
      runtimeWorker: "gardener-demo-team",
      runtimeOrigin: "https://runner.example.workers.dev",
    },
    cliVersion: "0.1.2",
    deploymentHash: null,
    deployedAt: null,
  })),
  readProjectLock: vi.fn(async () => ({
    tasks: {
      "bug-intake": { bundleHash: "a".repeat(64) },
    },
  })),
  wrangler: vi.fn(),
}));

vi.mock("../src/actions-installation", () => ({
  resolveInstallation: mocks.resolveInstallation,
  readProjectLock: mocks.readProjectLock,
}));
vi.mock("../src/commands", () => ({ wrangler: mocks.wrangler }));

import { isolatedWranglerDirectory } from "../src/actions-d1";
import {
  listActionsRepositories,
  setRepositoryEnabled,
} from "../src/actions-operations";

function d1(rows: Array<Record<string, unknown>>) {
  return { status: 0, stdout: JSON.stringify([{ results: rows }]), stderr: "" };
}

/** The SQL of one wrangler call. Writes arrive as a file that is removed after the call. */
function command(args: string[]): string {
  return args.includes("--file")
    ? readFileSync(args[args.indexOf("--file") + 1]!, "utf8")
    : args[args.indexOf("--command") + 1]!;
}

const executed: string[] = [];

describe("Actions operational controls", () => {
  afterAll(() => rmSync(isolatedWranglerDirectory(), { recursive: true, force: true }));
  beforeEach(() => {
    vi.clearAllMocks();
    executed.length = 0;
    mocks.wrangler.mockImplementation((_root: string, _cwd: string, args: string[]) => {
      const sql = command(args);
      executed.push(sql);
      if (/SELECT repository_id FROM actions_repository_enrollments/.test(sql)) return d1([{ repository_id: "1379585475" }]);
      if (/SELECT enabled FROM actions_repository_tasks/.test(sql)) return d1([{ enabled: 1 }]);
      if (/SELECT COUNT\(\*\) AS task_count/.test(sql)) return d1([{ task_count: 2, enabled_count: 0 }]);
      if (/SELECT enabled FROM actions_repository_enrollments/.test(sql)) return d1([{ enabled: 0 }]);
      if (/SELECT repository_id,owner_id/.test(sql)) return d1([{ repository_id: "1379585475", enabled: 1 }]);
      return { status: 0, stdout: "", stderr: "" };
    });
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
    expect(executed.join("\n"))
      .toContain("UPDATE actions_repository_enrollments SET enabled=0");
  });
});
