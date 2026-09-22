/// <reference types="node" />
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProject,
  DEFAULT_WORKFLOW_REF,
  initializeProject,
  upgradeProjectRelease,
} from "../src/project";
import { compileTaskSource } from "../src/task-authoring";

const TASK = `---
schema: gardener.task/v1
id: example-task
name: Example task
description: A deterministic example task.
trigger:
  event: github.issue.opened
  labels-all:
    - gardener-example
tools:
  - repository.list_files
  - repository.read_file
effects:
  - issue.comment.create
network:
  default: deny
  allow: []
  deny: []
limits:
  runtime-seconds: 120
  max-turns: 4
  max-tool-calls: 8
  input-tokens: 12000
  output-tokens: 1200
---
Inspect the repository and propose one concise issue comment.
`;

describe("TASK.md compiler", () => {
  it("compiles deterministic canonical TaskBundleV1 bytes", async () => {
    const first = await compileTaskSource(TASK);
    const second = await compileTaskSource(TASK.replaceAll("\n", "\r\n"));
    expect(first).toEqual(second);
    expect(first.bundle).toMatchObject({
      schemaVersion: "gardener.task-bundle/v1",
      taskId: "example-task",
      tools: ["repository.list_files", "repository.read_file"],
      effects: ["issue.comment.create"],
    });
    expect(first.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(first.canonicalBundle)).toEqual(first.bundle);
  });

  it("rejects unknown keys, unsafe labels, and repository execution", async () => {
    await expect(compileTaskSource(TASK.replace(
      "description: A deterministic example task.",
      "description: A deterministic example task.\nunknown: true",
    ))).rejects.toThrow();
    await expect(compileTaskSource(TASK.replace("gardener-example", "bad'label")))
      .rejects.toThrow(/labels may contain/);
    await expect(compileTaskSource(TASK.replace("repository.list_files", "repository.exec")))
      .rejects.toThrow();
  });
});

describe("local Gardener project", () => {
  it("scaffolds two demos and builds byte-identical lock and workflows", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-"));
    const initialized = await initializeProject({ repositoryRoot: root, demos: true });
    expect(initialized.created).toEqual([
      ".gardener/gardener.json",
      ".gardener/tasks/bug-intake/TASK.md",
      ".gardener/tasks/docs-helper/TASK.md",
    ]);

    const first = await buildProject({ repositoryRoot: root });
    const lockFirst = await readFile(first.lockPath, "utf8");
    const workflowsFirst = await Promise.all(first.tasks.map((task) =>
      readFile(join(root, task.workflow), "utf8")
    ));
    const second = await buildProject({ repositoryRoot: root });
    expect(await readFile(second.lockPath, "utf8")).toBe(lockFirst);
    expect(await Promise.all(second.tasks.map((task) => readFile(join(root, task.workflow), "utf8"))))
      .toEqual(workflowsFirst);

    expect(first.tasks.map((task) => task.taskId)).toEqual(["bug-intake", "docs-helper"]);
    expect(workflowsFirst.join("\n")).toContain("vars.GARDENER_RUNTIME_URL");
    expect(workflowsFirst.join("\n")).toContain(
      "scuffi/gardener/.github/workflows/gardener-task.yml@ca4533054b1f6af96fa2f4d248ccb10bcf1d1a76",
    );
    expect(workflowsFirst.join("\n")).toContain("gardener-bug");
    expect(workflowsFirst.join("\n")).toContain("gardener-docs");
    expect(workflowsFirst.join("\n")).not.toMatch(/\$\{\{\s*secrets\.|password|api[_-]?key/i);
    const lock = JSON.parse(lockFirst) as { tasks: Record<string, { bundleHash: string }> };
    expect(lock.tasks["bug-intake"]?.bundleHash).toBe(first.tasks[0]?.bundleHash);
  });

  it("upgrades an existing project bridge pin only when explicitly requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-upgrade-"));
    await initializeProject({ repositoryRoot: root, demos: true });
    const projectPath = join(root, ".gardener/gardener.json");
    const oldWorkflowRef = `scuffi/gardener-actions/.github/workflows/gardener-task.yml@${"a".repeat(40)}`;
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.release.workflowRef = oldWorkflowRef;
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    await initializeProject({ repositoryRoot: root, demos: true });
    expect(JSON.parse(await readFile(projectPath, "utf8")).release.workflowRef).toBe(oldWorkflowRef);

    await expect(upgradeProjectRelease({ repositoryRoot: root })).resolves.toMatchObject({
      previousWorkflowRef: oldWorkflowRef,
      workflowRef: DEFAULT_WORKFLOW_REF,
      changed: true,
    });
    await expect(upgradeProjectRelease({ repositoryRoot: root })).resolves.toMatchObject({ changed: false });
  });

  it("explains how to recover when upgrade runs outside a Gardener project", async () => {
    const root = await mkdtemp(join(tmpdir(), "not-a-gardener-project-"));
    await expect(upgradeProjectRelease({ repositoryRoot: root }))
      .rejects.toThrow(/Pass --repository-root/);
  });

  it("preserves source files and refuses to overwrite an unmanaged workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-"));
    await initializeProject({ repositoryRoot: root, demos: true });
    const taskPath = join(root, ".gardener/tasks/bug-intake/TASK.md");
    const custom = `${await readFile(taskPath, "utf8")}\nCustom local text.\n`;
    await writeFile(taskPath, custom);
    const repeated = await initializeProject({ repositoryRoot: root, demos: true });
    expect(repeated.created).toEqual([]);
    expect(await readFile(taskPath, "utf8")).toBe(custom);

    const collisionRoot = await mkdtemp(join(tmpdir(), "gardener-project-"));
    await initializeProject({ repositoryRoot: collisionRoot, demos: false });
    await mkdir(join(collisionRoot, ".github/workflows"), { recursive: true });
    await writeFile(join(collisionRoot, ".github/workflows/gardener-example-task.yml"), "name: user workflow\n");
    await mkdir(join(collisionRoot, ".gardener/tasks/example"), { recursive: true });
    await writeFile(join(collisionRoot, ".gardener/tasks/example/TASK.md"), TASK);
    await expect(buildProject({ repositoryRoot: collisionRoot }))
      .rejects.toThrow(/Refusing to overwrite non-Gardener workflow/);
  });
});
