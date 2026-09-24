/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { actionsEnrollmentSql } from "../src/actions";
import { parse } from "../src/args";
import { defaultSourceRoot } from "../src/distribution";
import { writePrivateJson, writePrivateText } from "../src/state";
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

const EXEC_TASK = `---
schema: gardener.task/v1
id: egress-task
name: Egress task
description: A task that declares repository.exec.
trigger:
  event: github.issue.opened
tools:
  - repository.exec
effects:
  - issue.comment.create
network:
  default: allow
  allow: []
  deny: []
limits:
  runtime-seconds: 300
  max-turns: 8
  max-tool-calls: 12
  input-tokens: 24000
  output-tokens: 4000
---
Investigate the issue.
`;

describe("Gardener CLI", () => {
  it("prints every build warning on stderr, not stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-cli-warn-"));
    const cliPath = join(process.cwd(), "dist/cli.js");

    // A project with no exec task warns about nothing.
    const init = spawnSync(process.execPath, [cliPath, "--", "init", "--demos"], {
      cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
    });
    expect(init.status, init.stderr).toBe(0);
    const quiet = spawnSync(process.execPath, [cliPath, "--", "build"], {
      cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
    });
    expect(quiet.status, quiet.stderr).toBe(0);
    expect(quiet.stderr).not.toMatch(/unrestricted network egress/);

    // Adding a repository.exec task makes the exposure visible at build time.
    await mkdir(join(root, ".gardener/tasks/egress"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/egress/TASK.md"), EXEC_TASK);
    const loud = spawnSync(process.execPath, [cliPath, "--", "build"], {
      cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
    });
    expect(loud.status, loud.stderr).toBe(0);
    expect(loud.stderr).toMatch(/^warning: /m);
    expect(loud.stderr).toMatch(/egress-task/);
    expect(loud.stderr).toMatch(/unrestricted network egress/);
    expect(loud.stderr).toMatch(/exfiltrate private source/);
    expect(loud.stderr).toMatch(/demo-only and is not production-ready/);

    // stdout stays machine-readable: the warning must not be mixed into it.
    expect(loud.stdout).not.toMatch(/unrestricted network egress/);
    expect(loud.stdout).toMatch(/egress-task [0-9a-f]{64} /);
  });

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

    const incompleteUpgrade = spawnSync(process.execPath, [
      "dist/cli.js", "--", "upgrade", "--workspace", "demo-team",
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(incompleteUpgrade.status).toBe(1);
    expect(incompleteUpgrade.stderr).toContain("--repository is required");
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

  it("renders deterministic full-SHA-pinned enrollment SQL", () => {
    const workflowRef = `gardener/actions/.github/workflows/triage.yml@${"a".repeat(40)}`;
    const audience = "https://runner.example.workers.dev";
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
    expect(() => actionsEnrollmentSql({
      repositoryId: "1374842705",
      ownerId: "45369682",
      ownerLogin: "owner",
      repositoryName: "repository",
      visibility: "private",
      workflowRef: "gardener/actions/.github/workflows/triage.yml@main",
      audience,
    })).toThrow(/full-sha/i);
    expect(() => actionsEnrollmentSql({
      repositoryId: "1374842705",
      ownerId: "45369682",
      ownerLogin: "owner",
      repositoryName: "repository",
      visibility: "private",
      workflowRef,
      audience: `${audience}/path`,
    })).toThrow(/HTTPS origin/);
  });

  it("uses restrained TTY colours and respects NO_COLOR", () => {
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;
    expect(terminal.title("Gardener")).toContain("\u001b[1m\u001b[32m");
    expect(terminal.value("agents")).toContain("\u001b[36m");
    process.env.NO_COLOR = "";
    expect(terminal.title("Gardener")).toBe("Gardener");
    expect(terminal.value("agents")).toBe("agents");
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

  it("writes installation state with owner-only modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gardener-cli-test-"));
    const state = join(directory, "workspace", "installation.json");
    await writePrivateJson(state, { workspace: "team-one" });
    expect((await stat(join(directory, "workspace"))).mode & 0o777).toBe(0o700);
    expect((await stat(state)).mode & 0o777).toBe(0o600);
    await writePrivateText(state, "replacement\n");
    expect(await readFile(state, "utf8")).toBe("replacement\n");
    expect((await stat(state)).mode & 0o777).toBe(0o600);
  });
});
