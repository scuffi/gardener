/// <reference types="node" />
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  buildProject,
  DEFAULT_WORKFLOW_REF,
  initializeProject,
  upgradeProjectRelease,
} from "../src/project";
import { operationKindValues } from "@gardener/contracts";
import { compileTaskSource, DEFAULT_TASK_MODEL, effectFamilyGlobValues, expandEffectSelectors, modelWarning } from "../src/task-authoring";

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

const WIDE_TASK = `---
schema: gardener.task/v1
id: wide-task
name: Wide task
description: A task exercising the full common trigger set.
triggers:
  - event: github.issue.opened
  - event: github.issue.labeled
    labels-all:
      - gardener-wide
  - event: github.pull_request.opened
  - event: github.pull_request.synchronize
  - event: github.push
    branches: [main]
  - event: github.workflow_dispatch
  - event: github.schedule
    cron: 0 3 * * 1
tools:
  - repository.list_files
  - repository.exec
  - provider.api.read
effects:
  - issue.comment.create
  - pull_request.comment.create
  - git.*
network:
  default: allow
  allow: []
  deny: []
limits:
  runtime-seconds: 300
  max-turns: 8
  max-tool-calls: 32
  input-tokens: 64000
  output-tokens: 8000
---
Inspect the repository and propose an ordered effect plan.
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

  it("writes Gardener's default model into the bundle unless the task names one", async () => {
    expect((await compileTaskSource(TASK)).bundle.model).toBe(DEFAULT_TASK_MODEL);
    const named = await compileTaskSource(TASK.replace("tools:", "model: openai/gpt-5.1\ntools:"));
    expect(named.bundle.model).toBe("openai/gpt-5.1");
    expect(named.bundleHash).not.toBe((await compileTaskSource(TASK)).bundleHash);
    await expect(compileTaskSource(TASK.replace("tools:", "model: 'gpt 5'\ntools:"))).rejects.toThrow(/AI Gateway model id/);
  });

  it("warns only about models without a native request format", () => {
    for (const model of ["@cf/moonshotai/kimi-k2.6", "openai/gpt-5.1", "anthropic/claude-haiku-4-5"]) {
      expect(modelWarning(model)).toBeUndefined();
    }
    expect(modelWarning("google-ai-studio/gemini-2.5-flash")).toMatch(/may fail if it cannot call tools/);
  });

  it("rejects unknown keys and unsafe labels", async () => {
    await expect(compileTaskSource(TASK.replace(
      "description: A deterministic example task.",
      "description: A deterministic example task.\nunknown: true",
    ))).rejects.toThrow();
    await expect(compileTaskSource(TASK.replace("gardener-example", "bad'label")))
      .rejects.toThrow(/labels may contain/);
    await expect(compileTaskSource(TASK.replace(
      "trigger:\n  event: github.issue.opened",
      "trigger:\n  event: github.pull_request_target.opened",
    ))).rejects.toThrow();
  });

  it("accepts repository execution and the read-only provider API tool", async () => {
    const compiled = await compileTaskSource(TASK.replace(
      "  - repository.list_files",
      "  - repository.list_files\n  - repository.exec\n  - provider.api.read",
    ));
    expect(compiled.bundle.tools).toEqual([
      "repository.list_files",
      "repository.exec",
      "provider.api.read",
      "repository.read_file",
    ]);
    await expect(compileTaskSource(TASK.replace(
      "  - repository.list_files",
      "  - repository.list_files\n  - repository.list_files",
    ))).rejects.toThrow(/tools must be unique/);
  });

  it("expands family globs into the deterministic exact allowlist", async () => {
    expect(expandEffectSelectors(["issue.*"])).toEqual([
      "issue.label.add",
      "issue.label.remove",
      "issue.comment.create",
      "issue.comment.update",
      "issue.close",
      "issue.reopen",
      "issue.assignee.add",
      "issue.assignee.remove",
    ]);
    expect(expandEffectSelectors(["git.*"])).toEqual(["branch.create", "commit.create"]);
    expect(expandEffectSelectors(["check.*"])).toEqual(["check.rerun"]);
    expect(expandEffectSelectors([...effectFamilyGlobValues])).toEqual([...operationKindValues]);
    // Overlapping selectors collapse to canonical order without duplication.
    expect(expandEffectSelectors(["release.publish", "release.*", "issue.close"])).toEqual([
      "issue.close",
      "release.create",
      "release.update",
      "release.publish",
      "release.delete",
    ]);

    const compiled = await compileTaskSource(TASK.replace(
      "  - issue.comment.create",
      "  - pull_request.*\n  - issue.comment.create",
    ));
    expect(compiled.bundle.effects).toEqual(expandEffectSelectors(["pull_request.*", "issue.comment.create"]));
    await expect(compileTaskSource(TASK.replace(
      "  - issue.comment.create",
      "  - issue.*\n  - issue.*",
    ))).rejects.toThrow(/effect selectors must be unique/);
    await expect(compileTaskSource(TASK.replace("  - issue.comment.create", "  - issue.labels.update")))
      .rejects.toThrow();
  });

  it("compiles the common trigger set and enforces per-event fields", async () => {
    const multi = TASK.replace(
      "trigger:\n  event: github.issue.opened\n  labels-all:\n    - gardener-example",
      [
        "triggers:",
        "  - event: github.issue.opened",
        "    labels-all:",
        "      - gardener-example",
        "  - event: github.issue_comment.created",
        "  - event: github.pull_request.synchronize",
        "  - event: github.pull_request_review.submitted",
        "  - event: github.pull_request_review_comment.created",
        "  - event: github.push",
        "    branches: [main, 'release/*']",
        "  - event: github.workflow_dispatch",
        "  - event: github.schedule",
        "    cron: 0 3 * * 1",
        "  - event: github.discussion.answered",
        "  - event: github.discussion_comment.created",
      ].join("\n"),
    );
    const compiled = await compileTaskSource(multi);
    expect(compiled.bundle.triggers).toEqual([
      { kind: "github.issue.opened", labelsAll: ["gardener-example"] },
      { kind: "github.issue_comment.created", labelsAll: [] },
      { kind: "github.pull_request.synchronize", labelsAll: [] },
      { kind: "github.pull_request_review.submitted", labelsAll: [] },
      { kind: "github.pull_request_review_comment.created", labelsAll: [] },
      { kind: "github.push", branches: ["main", "release/*"] },
      { kind: "github.workflow_dispatch" },
      { kind: "github.schedule", cron: "0 3 * * 1" },
      { kind: "github.discussion.answered", labelsAll: [] },
      { kind: "github.discussion_comment.created", labelsAll: [] },
    ]);

    const withTrigger = (body: string) =>
      compileTaskSource(TASK.replace(
        "trigger:\n  event: github.issue.opened\n  labels-all:\n    - gardener-example",
        body,
      ));
    await expect(withTrigger("trigger:\n  event: github.push")).rejects.toThrow(/branches is required/);
    await expect(withTrigger("trigger:\n  event: github.schedule")).rejects.toThrow(/cron is required/);
    await expect(withTrigger("trigger:\n  event: github.push\n  branches: [main]\n  cron: 0 3 * * 1"))
      .rejects.toThrow(/cron is not supported/);
    await expect(withTrigger("trigger:\n  event: github.workflow_dispatch\n  labels-all: [x]"))
      .rejects.toThrow(/labels-all is not supported/);
    await expect(withTrigger("trigger:\n  event: github.issue.opened\n  branches: [main]"))
      .rejects.toThrow(/branches is not supported/);
    await expect(compileTaskSource(TASK.replace(
      "trigger:\n  event: github.issue.opened",
      "triggers:\n  - event: github.issue.opened\ntrigger:\n  event: github.issue.opened",
    ))).rejects.toThrow();
    await expect(compileTaskSource(TASK.replace(/trigger:\n  event: [^\n]*\n  labels-all:\n    - gardener-example\n/, "")))
      .rejects.toThrow(/exactly one of trigger or triggers/);
  });

  it("records optional effect ceilings and rejects any fork-execution opt-in", async () => {
    const bounded = await compileTaskSource(TASK.replace(
      "  output-tokens: 1200",
      "  output-tokens: 1200\n  max-effect-operations: 12\n  max-effect-bytes: 262144",
    ));
    expect(bounded.bundle.limits).toMatchObject({ maxEffectOperations: 12, maxEffectBytes: 262_144 });
    expect(JSON.parse(bounded.canonicalBundle).limits).toMatchObject({
      maxEffectOperations: 12,
      maxEffectBytes: 262_144,
    });

    const base = await compileTaskSource(TASK);
    expect(base.bundle.limits.maxEffectOperations).toBeUndefined();
    // Unset ceilings never reach canonical bytes, so hashes stay stable.
    expect(base.canonicalBundle).not.toContain("maxEffectOperations");
    // No fork-execution field exists in the contract, so the bundle bytes match
    // the originally qualified shape exactly.
    expect(base.canonicalBundle).not.toContain("allowForkExecution");

    await expect(compileTaskSource(TASK.replace("network:", "allow-fork-execution: true\nnetwork:")))
      .rejects.toThrow();
  });

  it("emits triggers in canonical order regardless of authoring order", async () => {
    const reordered = await compileTaskSource(TASK.replace(
      "trigger:\n  event: github.issue.opened\n  labels-all:\n    - gardener-example",
      "triggers:\n  - event: github.pull_request.opened\n  - event: github.issue.opened",
    ));
    expect(reordered.bundle.triggers.map((trigger) => trigger.kind)).toEqual([
      "github.issue.opened",
      "github.pull_request.opened",
      "github.workflow_dispatch",
    ]);
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
    expect(workflowsFirst.join("\n")).toContain(DEFAULT_WORKFLOW_REF);
    expect(workflowsFirst.join("\n")).toContain("gardener-bug");
    expect(workflowsFirst.join("\n")).toContain("gardener-docs");
    expect(workflowsFirst.join("\n")).not.toMatch(/\$\{\{\s*secrets\.|password|api[_-]?key/i);
    const lock = JSON.parse(lockFirst) as {
      tasks: Record<string, { bundleHash: string; bundle: { limits: { maxTurns: number; inputTokens: number } } }>;
    };
    expect(lock.tasks["bug-intake"]?.bundleHash).toBe(first.tasks[0]?.bundleHash);
    expect(Object.values(lock.tasks).map((task) => task.bundle.limits)).toEqual([
      expect.objectContaining({ maxTurns: 16, inputTokens: 60_000 }),
      expect.objectContaining({ maxTurns: 16, inputTokens: 60_000 }),
    ]);
  });

  it("renders deterministic multi-trigger workflows with derived permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-triggers-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    await mkdir(join(root, ".gardener/tasks/wide"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/wide/TASK.md"), WIDE_TASK);

    const built = await buildProject({ repositoryRoot: root });
    const workflow = await readFile(join(root, built.tasks[0]!.workflow), "utf8");

    // Every declared event reaches `on:` in canonical order with exact types.
    expect(workflow).toContain("  issues:\n    types: [opened, labeled]");
    expect(workflow).toContain("  pull_request:\n    types: [opened, synchronize]");
    expect(workflow).toContain("  push:\n    branches:\n      - \"main\"");
    expect(workflow).toContain("  schedule:\n    - cron: \"0 3 * * 1\"");
    expect(workflow).toContain("  workflow_dispatch:");
    expect(workflow).not.toContain("pull_request_target");

    // Fork guard is injected for pull-request events without the opt-in.
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toContain("github.event_name == 'issues' && github.event.action == 'labeled'");
    expect(workflow).toContain("contains(github.event.issue.labels.*.name, 'gardener-wide')");
    expect(workflow).toContain("github.event_name == 'schedule'");

    // Caller permissions are the fixed planning read union plus task-exact writes.
    expect(workflow).toContain([
      "    permissions:",
      "      checks: read",
      "      contents: write",
      "      discussions: read",
      "      id-token: write",
      "      issues: write",
      "      pull-requests: write",
      "      statuses: read",
    ].join("\n"));
    expect(workflow).not.toContain("actions:");

    // Rebuilds stay byte-identical.
    await buildProject({ repositoryRoot: root });
    expect(await readFile(join(root, built.tasks[0]!.workflow), "utf8")).toBe(workflow);
  });

  it("keeps the reusable planning token read-only while apply inherits caller-exact writes", async () => {
    const source = await readFile(join(import.meta.dirname, "../../../.github/workflows/gardener-task.yml"), "utf8");
    const workflow = parseYaml(source) as {
      permissions?: unknown;
      jobs: Record<string, { permissions?: Record<string, string>; environment?: unknown }>;
    };
    expect(workflow.permissions).toBeUndefined();
    expect(Object.keys(workflow.jobs).sort()).toEqual(["apply", "plan"]);
    expect(workflow.jobs.plan?.permissions).toEqual({
      checks: "read",
      contents: "read",
      discussions: "read",
      issues: "read",
      "pull-requests": "read",
      statuses: "read",
      "id-token": "write",
    });
    expect(workflow.jobs.apply?.permissions).toBeUndefined();
    expect(workflow.jobs.apply?.environment).toBeUndefined();
    expect(source).not.toContain("gardener-effects");
    expect(source).not.toContain("requires-approval");
  });

  it("offers optional manual-run inputs, with a target for each resource the task acts on", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-dispatch-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    await mkdir(join(root, ".gardener/tasks/wide"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/wide/TASK.md"), WIDE_TASK);
    const built = await buildProject({ repositoryRoot: root });
    const workflow = await readFile(join(root, built.tasks[0]!.workflow), "utf8");
    const inputs = (parseYaml(workflow) as { on: { workflow_dispatch: { inputs: Record<string, Record<string, unknown>> } } })
      .on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual(["prompt", "issue", "pull_request"]);
    for (const input of Object.values(inputs)) {
      expect(input).toMatchObject({ required: false, type: "string" });
      expect(input).not.toHaveProperty("default");
    }
    expect(String(inputs.prompt!.description)).toContain("20000 characters");
  });

  it("warns that repository.exec tasks have unrestricted demo-only egress", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-egress-"));
    await initializeProject({ repositoryRoot: root, demos: true });
    // Demo tasks declare no exec, so a clean project warns about nothing.
    expect((await buildProject({ repositoryRoot: root })).warnings).toEqual([]);

    await mkdir(join(root, ".gardener/tasks/wide"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/wide/TASK.md"), WIDE_TASK);
    const warnings = (await buildProject({ repositoryRoot: root })).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unrestricted network egress/);
    expect(warnings[0]).toMatch(/exfiltrate private source/);
    expect(warnings[0]).toMatch(/demo-only and is not production-ready/);
  });

  it("always renders the same-repository guard for pull-request triggers", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-fork-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    await mkdir(join(root, ".gardener/tasks/wide"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/wide/TASK.md"), WIDE_TASK);
    const built = await buildProject({ repositoryRoot: root });
    const workflow = await readFile(join(root, built.tasks[0]!.workflow), "utf8");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
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
