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
  pinCliScripts,
  planProject,
  staleProjectFiles,
  GENERATED_MARKER,
  SYNC_WORKFLOW,
  projectSyncWorkflow,
  upgradeProjectRelease,
} from "../src/project";
import { operationKindValues, taskToolV1Schema, taskTriggerKindValues } from "@gardener/contracts";
import { renderTaskGuide, TASK_GUIDE_PATH } from "../src/task-guide";
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

  it("compiles branches options on branch-writing effect entries", async () => {
    const withOptions = (effects: string) => TASK.replace("effects:\n  - issue.comment.create\n", `effects:\n${effects}`);
    const compiled = await compileTaskSource(withOptions(
      "  - issue.comment.create\n  - kind: commit.create\n    branches: [gardener/**, docs/*]\n  - branch.create\n",
    ));
    expect(compiled.bundle.effects).toEqual(["issue.comment.create", "branch.create", "commit.create"]);
    // Sorted, so the order the author listed them in does not move the hash.
    expect(compiled.bundle.effectOptions).toEqual({ "commit.create": { branches: ["docs/*", "gardener/**"] } });
    const reordered = await compileTaskSource(withOptions(
      "  - issue.comment.create\n  - kind: commit.create\n    branches: [docs/*, gardener/**]\n  - branch.create\n",
    ));
    expect(reordered.bundleHash).toBe(compiled.bundleHash);
    // Without options the bundle is unchanged, so existing hashes hold.
    expect((await compileTaskSource(TASK)).bundle).not.toHaveProperty("effectOptions");

    await expect(compileTaskSource(withOptions("  - kind: issue.create\n    branches: [docs/*]\n"))).rejects.toThrow();
    await expect(compileTaskSource(withOptions("  - kind: commit.create\n"))).rejects.toThrow();
    await expect(compileTaskSource(withOptions("  - kind: commit.create\n    branches: [docs/**x]\n"))).rejects.toThrow();
    await expect(compileTaskSource(withOptions(
      "  - commit.create\n  - kind: commit.create\n    branches: [docs/*]\n",
    ))).rejects.toThrow(/unique/);
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
      "issue.create",
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
      { kind: "github.issue.opened", labelsAll: ["gardener-example"], mentions: [], authors: "any" },
      { kind: "github.issue_comment.created", labelsAll: [], mentions: [], authors: "maintainers" },
      { kind: "github.pull_request.synchronize", labelsAll: [] },
      { kind: "github.pull_request_review.submitted", labelsAll: [], mentions: [], authors: "maintainers" },
      { kind: "github.pull_request_review_comment.created", labelsAll: [], mentions: [], authors: "maintainers" },
      { kind: "github.push", branches: ["main", "release/*"] },
      { kind: "github.workflow_dispatch" },
      { kind: "github.schedule", cron: "0 3 * * 1" },
      { kind: "github.discussion.answered", labelsAll: [] },
      { kind: "github.discussion_comment.created", labelsAll: [], mentions: [], authors: "maintainers" },
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
      ".gardener/SKILL.md",
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

  it("resolves mentions and author defaults into the bundle", async () => {
    const withTrigger = (body: string, handle?: string) =>
      compileTaskSource(TASK.replace(
        "trigger:\n  event: github.issue.opened\n  labels-all:\n    - gardener-example",
        body,
      ), "TASK.md", handle === undefined ? {} : { handle });
    const triggers = async (body: string, handle?: string) => (await withTrigger(body, handle)).bundle.triggers;

    // Comment and review triggers default to maintainers; so does any trigger with mentions.
    expect(await triggers("trigger:\n  event: github.issue_comment.created"))
      .toEqual([{ kind: "github.issue_comment.created", labelsAll: [], mentions: [], authors: "maintainers" }, { kind: "github.workflow_dispatch" }]);
    expect((await triggers("trigger:\n  event: github.pull_request_review.submitted"))[0])
      .toMatchObject({ authors: "maintainers" });
    expect((await triggers("trigger:\n  event: github.issue.opened"))[0]).toMatchObject({ mentions: [], authors: "any" });
    expect((await triggers("trigger:\n  event: github.issue.opened\n  mentions: [octocat]"))[0])
      .toMatchObject({ mentions: ["octocat"], authors: "maintainers" });
    expect((await triggers("trigger:\n  event: github.issue_comment.created\n  authors: any"))[0])
      .toMatchObject({ authors: "any" });

    // self resolves to the project handle; @, case and repeats are normalised.
    expect((await triggers("trigger:\n  event: github.issue_comment.created\n  mentions: [self, '@OctoCat', octocat]", "garden-bot"))[0])
      .toMatchObject({ mentions: ["garden-bot", "octocat"] });
    await expect(withTrigger("trigger:\n  event: github.issue_comment.created\n  mentions: [self]"))
      .rejects.toThrow(/mentions self, but .gardener\/gardener.json sets no handle/);
    await expect(withTrigger("trigger:\n  event: github.issue_comment.created\n  mentions: ['not a handle']"))
      .rejects.toThrow(/not a GitHub handle/);
    await expect(withTrigger("trigger:\n  event: github.issue_comment.created\n  mentions: [-bad]"))
      .rejects.toThrow(/not a GitHub handle/);

    // Only triggers with authored text take the filters.
    await expect(withTrigger("trigger:\n  event: github.issue.labeled\n  mentions: [octocat]"))
      .rejects.toThrow(/mentions is not supported/);
    await expect(withTrigger("trigger:\n  event: github.push\n  branches: [main]\n  authors: any"))
      .rejects.toThrow(/authors is not supported/);
    await expect(withTrigger("trigger:\n  event: github.workflow_dispatch\n  mentions: [octocat]"))
      .rejects.toThrow(/mentions is not supported/);
  });

  it("prefilters mentions and edits, but not authors, in the workflow condition", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-mentions-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    const projectPath = join(root, ".gardener/gardener.json");
    const project = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
    await writeFile(projectPath, JSON.stringify({ ...project, handle: "@Garden-Bot" }));
    await mkdir(join(root, ".gardener/tasks/mention"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/mention/TASK.md"), TASK.replace(
      "trigger:\n  event: github.issue.opened\n  labels-all:\n    - gardener-example",
      "triggers:\n  - event: github.issue_comment.created\n    mentions: [self]\n  - event: github.issue_comment.edited\n    mentions: [self, octocat]\n  - event: github.issue.opened",
    ));
    const built = await buildProject({ repositoryRoot: root });
    const workflow = await readFile(join(root, built.tasks[0]!.workflow), "utf8");
    // Mention triggers default to authors: maintainers, which the Worker
    // decides after the bridge looks up the author's permission, so a private
    // org member is not skipped here.
    expect(workflow).not.toContain("author_association");
    expect(workflow).toContain(
      "(github.event_name == 'issue_comment' && github.event.action == 'created' && contains(github.event.comment.body, '@garden-bot'))",
    );
    expect(workflow).toContain(
      "(github.event_name == 'issue_comment' && github.event.action == 'edited' && "
      + "(contains(github.event.comment.body, '@garden-bot') || contains(github.event.comment.body, '@octocat')) && github.event.changes.body)",
    );
    // issue.opened keeps authors: any and no mention, so it adds no clauses.
    expect(workflow).toContain("(github.event_name == 'issues' && github.event.action == 'opened')");
    expect(workflow).toContain("  issue_comment:\n    types: [created, edited]");
  });

  it("checks out the pull request head only for tasks that commit beyond gardener/**", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-checkout-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    const prTask = (effects: string) => TASK
      .replace("trigger:\n  event: github.issue.opened\n  labels-all:\n    - gardener-example", "trigger:\n  event: github.pull_request.labeled\n  labels-all:\n    - gardener-fix")
      .replace("effects:\n  - issue.comment.create\n", `effects:\n${effects}`);
    await mkdir(join(root, ".gardener/tasks/pusher"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/pusher/TASK.md"), prTask(
      "  - kind: commit.create\n    branches: [\"**\"]\n",
    ).replace("id: example-task", "id: pusher"));
    await mkdir(join(root, ".gardener/tasks/drafter"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/drafter/TASK.md"), prTask(
      "  - branch.create\n  - commit.create\n",
    ).replace("id: example-task", "id: drafter"));
    const built = await buildProject({ repositoryRoot: root });
    const workflowOf = async (id: string) => readFile(join(root, built.tasks.find((task) => task.taskId === id)!.workflow), "utf8");
    expect(await workflowOf("pusher")).toContain("      checkout-ref: ${{ github.event.pull_request.head.sha }}\n");
    expect(await workflowOf("drafter")).not.toContain("checkout-ref");
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
    expect(Object.keys(workflow.jobs).sort()).toEqual(["acknowledge", "apply", "plan", "settle"]);
    // The reaction jobs are checkout-free and run only fixed API calls, so
    // they inherit the caller's grant like apply, and never fail the run.
    for (const name of ["acknowledge", "settle"]) {
      const job = workflow.jobs[name] as { permissions?: unknown; steps: Array<{ uses?: string; "continue-on-error"?: boolean }> };
      expect(job.permissions).toBeUndefined();
      expect(job.steps.every((step) => step.uses === undefined && step["continue-on-error"] === true)).toBe(true);
    }
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

  it("passes the plan timeout only to workflows that define it, and warns when an earlier pin would cut a run short", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-timeout-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    const projectPath = join(root, ".gardener/gardener.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    // 0.1.7's task workflow, the last without the input.
    project.release.workflowRef = "scuffi/gardener/.github/workflows/gardener-task.yml@3a0bc85d1f5cffccb50fba787b18334e4c21ba72";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    for (const [id, runtime] of [["quick", 120], ["long", 900]] as const) {
      await mkdir(join(root, `.gardener/tasks/${id}`), { recursive: true });
      await writeFile(join(root, `.gardener/tasks/${id}/TASK.md`), TASK
        .replace("id: example-task", `id: ${id}`)
        .replace(/runtime-seconds: \d+/, `runtime-seconds: ${runtime}`));
    }
    const workflowOf = async (built: Awaited<ReturnType<typeof buildProject>>, id: string) =>
      readFile(join(root, built.tasks.find((task) => task.taskId === id)!.workflow), "utf8");

    const pinnedOld = await buildProject({ repositoryRoot: root });
    expect(await workflowOf(pinnedOld, "long")).not.toContain("plan-timeout-minutes");
    expect(pinnedOld.warnings.filter((warning) => warning.includes("gardener upgrade"))).toEqual([
      expect.stringMatching(/^Task long runs for up to 900 seconds, .* stops after 10 minutes\. Run gardener upgrade/),
    ]);

    // Any other pin, such as a later release, defines it.
    project.release.workflowRef = `scuffi/gardener/.github/workflows/gardener-task.yml@${"b".repeat(40)}`;
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    const upgraded = await buildProject({ repositoryRoot: root });
    expect(await workflowOf(upgraded, "long")).toContain("      plan-timeout-minutes: 25\n");
    expect(await workflowOf(upgraded, "quick")).toContain("      plan-timeout-minutes: 12\n");
    expect(upgraded.warnings.some((warning) => warning.includes("gardener upgrade"))).toBe(false);
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

describe("pinned CLI scripts", () => {
  it("moves only package.json scripts that pin this CLI, keeping the file's formatting", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-scripts-"));
    const original = `{
    "name": "demo",
    "description": "Uses @scuffi/gardener@0.1.3 generate",
    "scripts": {
        "gardener:generate": "npx --yes @scuffi/gardener@0.1.3 generate",
        "gardener:latest": "npx @scuffi/gardener@latest generate",
        "other": "npx @scuffi/gardener-extra@0.1.3 run",
        "pre": "npx @scuffi/gardener@0.1.3-rc.1 doctor && echo done"
    }
}
`;
    await writeFile(join(root, "package.json"), original);
    expect(await pinCliScripts({ repositoryRoot: root, version: "0.1.5" })).toEqual(["gardener:generate", "pre"]);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(original
      .replace('"npx --yes @scuffi/gardener@0.1.3 generate"', '"npx --yes @scuffi/gardener@0.1.5 generate"')
      .replace('"npx @scuffi/gardener@0.1.3-rc.1 doctor && echo done"', '"npx @scuffi/gardener@0.1.5 doctor && echo done"'));
    // Already current: nothing changes.
    expect(await pinCliScripts({ repositoryRoot: root, version: "0.1.5" })).toEqual([]);
  });

  it("reports every script that shared a rewritten value", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-scripts-shared-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { a: "npx @scuffi/gardener@0.1.3 generate", b: "npx @scuffi/gardener@0.1.3 generate" } }));
    expect(await pinCliScripts({ repositoryRoot: root, version: "0.1.5" })).toEqual(["a", "b"]);
  });

  it("does nothing without a package.json or scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-scripts-none-"));
    expect(await pinCliScripts({ repositoryRoot: root, version: "0.1.5" })).toEqual([]);
    await writeFile(join(root, "package.json"), '{"name":"x"}\n');
    expect(await pinCliScripts({ repositoryRoot: root, version: "0.1.5" })).toEqual([]);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe('{"name":"x"}\n');
  });
});

describe("sync workflow and staleness", () => {
  it("generates a sync caller pinned beside the task workflow, run only on the default branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-sync-"));
    await initializeProject({ repositoryRoot: root, demos: true });
    await buildProject({ repositoryRoot: root });
    const workflow = await readFile(join(root, SYNC_WORKFLOW), "utf8");
    const parsed = parseYaml(workflow) as Record<string, any>;
    expect(parsed.jobs.sync.uses).toBe(DEFAULT_WORKFLOW_REF.replace("/gardener-task.yml@", "/gardener-sync.yml@"));
    expect(parsed.jobs.sync.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(parsed.jobs.sync.if).toBe(
      "github.event_name != 'pull_request' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    );
    expect(parsed.jobs.sync.concurrency).toEqual({ group: "gardener-sync", "cancel-in-progress": false });
    const paths = [".gardener/**", ".github/workflows/gardener-*.yml"];
    expect(parsed.on.push.paths).toEqual(paths);
    expect(parsed.on.pull_request.paths).toEqual(paths);
    expect(parsed.permissions).toEqual({});
    // Pull requests get a read-only check: no OIDC token, no runtime URL.
    expect(parsed.jobs.check).toEqual({
      if: "github.event_name == 'pull_request'",
      concurrency: { group: "gardener-check-${{ github.ref }}", "cancel-in-progress": true },
      permissions: { contents: "read" },
      uses: DEFAULT_WORKFLOW_REF.replace("/gardener-task.yml@", "/gardener-check.yml@"),
    });
  });

  it("reports exactly the committed files generate would change", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-stale-"));
    await initializeProject({ repositoryRoot: root, demos: true });
    await buildProject({ repositoryRoot: root });
    expect(await staleProjectFiles(await planProject({ repositoryRoot: root }))).toEqual([]);

    // Editing a TASK.md without regenerating makes its workflow and the lock stale.
    const taskPath = join(root, ".gardener/tasks/bug-intake/TASK.md");
    await writeFile(taskPath, (await readFile(taskPath, "utf8")).replace("Bug intake", "Bug intake v2"));
    expect(await staleProjectFiles(await planProject({ repositoryRoot: root }))).toEqual([
      ".github/workflows/gardener-bug-intake.yml",
      ".gardener/gardener.lock.json",
    ]);
    await buildProject({ repositoryRoot: root });

    // A generated workflow left behind, or a missing sync workflow, is stale too.
    await writeFile(join(root, ".github/workflows/gardener-old-task.yml"), "# Generated by Gardener. Do not edit.\n");
    await writeFile(join(root, ".github/workflows/gardener-custom.yml"), "name: not ours\n");
    const { rm } = await import("node:fs/promises");
    await rm(join(root, SYNC_WORKFLOW));
    expect(await staleProjectFiles(await planProject({ repositoryRoot: root }))).toEqual([
      `${SYNC_WORKFLOW} (missing)`,
      ".github/workflows/gardener-old-task.yml (no longer generated)",
    ]);
  });

  it("plans no tasks once the last one is deleted, so the sync can stop them", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-empty-"));
    await initializeProject({ repositoryRoot: root, demos: true });
    await buildProject({ repositoryRoot: root });
    const { rm } = await import("node:fs/promises");
    await rm(join(root, ".gardener/tasks"), { recursive: true });
    const built = await buildProject({ repositoryRoot: root });
    expect(built.tasks).toEqual([]);
    expect(built.warnings).toEqual([expect.stringMatching(/no Gardener task runs/)]);
    const plan = await planProject({ repositoryRoot: root });
    expect(plan.tasks).toEqual([]);
    expect(await staleProjectFiles(plan)).toEqual([]);
    // The task workflows are gone; the sync workflow stays to carry the removal.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(root, ".github/workflows"))).toEqual(["gardener-sync.yml"]);
  });

  it("refuses a task whose workflow would overwrite the sync workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-sync-name-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    await mkdir(join(root, ".gardener/tasks/sync"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/sync/TASK.md"), TASK.replace(/^id: .*$/m, "id: sync"));
    await expect(buildProject({ repositoryRoot: root })).rejects.toThrow(/would overwrite \.github\/workflows\/gardener-sync\.yml/);
  });

  it("generates the sync workflow under a configured name and leaves the default path alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-sync-config-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    const projectPath = join(root, ".gardener/gardener.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    await writeFile(projectPath, `${JSON.stringify({ ...project, syncWorkflow: "gardener-repo-sync.yml" }, null, 2)}\n`);
    // Gardener's own repository publishes a reusable workflow at the default path.
    const reusable = "name: Sync Gardener tasks\non:\n  workflow_call:\n";
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(join(root, SYNC_WORKFLOW), reusable);
    await mkdir(join(root, ".gardener/tasks/triage"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/triage/TASK.md"), TASK);
    await buildProject({ repositoryRoot: root });
    expect(await readFile(join(root, SYNC_WORKFLOW), "utf8")).toBe(reusable);
    const generated = parseYaml(await readFile(join(root, ".github/workflows/gardener-repo-sync.yml"), "utf8"));
    expect(generated.jobs.sync.uses).toBe(DEFAULT_WORKFLOW_REF.replace("/gardener-task.yml@", "/gardener-sync.yml@"));
    expect(await projectSyncWorkflow(root)).toBe(".github/workflows/gardener-repo-sync.yml");
    expect(await staleProjectFiles(await planProject({ repositoryRoot: root }))).toEqual([]);
  });

  it("removes the old generated sync workflow when the name changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-sync-rename-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    await buildProject({ repositoryRoot: root });
    const projectPath = join(root, ".gardener/gardener.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    await writeFile(projectPath, JSON.stringify({ ...project, syncWorkflow: "gardener-repo-sync.yml" }));
    // The sync check reports the old file until generate removes it.
    expect(await staleProjectFiles(await planProject({ repositoryRoot: root }))).toContain(`${SYNC_WORKFLOW} (no longer generated)`);
    await buildProject({ repositoryRoot: root });
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(root, ".github/workflows"))).toEqual(["gardener-repo-sync.yml"]);
    expect(await staleProjectFiles(await planProject({ repositoryRoot: root }))).toEqual([]);
  });

  it("changes nothing when it refuses to overwrite a workflow Gardener did not write", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-sync-refuse-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    await mkdir(join(root, ".gardener/tasks/triage"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/triage/TASK.md"), TASK);
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(join(root, SYNC_WORKFLOW), "name: Mine\n");
    await expect(buildProject({ repositoryRoot: root })).rejects.toThrow(/Refusing to overwrite non-Gardener workflow/);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(root, ".github/workflows"))).toEqual(["gardener-sync.yml"]);
  });

  it("refuses a configured sync workflow name that a task also generates", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-sync-clash-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    const projectPath = join(root, ".gardener/gardener.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    await writeFile(projectPath, JSON.stringify({ ...project, syncWorkflow: "gardener-triage.yml" }));
    await mkdir(join(root, ".gardener/tasks/triage"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/triage/TASK.md"), TASK.replace(/^id: .*$/m, "id: triage"));
    await expect(buildProject({ repositoryRoot: root })).rejects.toThrow(/would overwrite \.github\/workflows\/gardener-triage\.yml/);
  });

  it("says to upgrade when gardener.json has a setting this release does not know", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-unknown-key-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    const projectPath = join(root, ".gardener/gardener.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    await writeFile(projectPath, JSON.stringify({ ...project, futureSetting: true }));
    await expect(planProject({ repositoryRoot: root })).rejects.toThrow(/sets futureSetting, which this Gardener release does not support\. Upgrade Gardener/);
    await writeFile(projectPath, JSON.stringify({ ...project, futureSetting: true, syncWorkflow: "sync.yml" }));
    await expect(planProject({ repositoryRoot: root })).rejects.toThrow(/also has 1 other error: syncWorkflow: syncWorkflow must be a file name/);
  });

  it("never marks the published reusable workflows as generated, so generate cannot delete them", async () => {
    // generate removes gardener-*.yml files that carry the marker; in Gardener's
    // own repository these are what every connected repository calls.
    for (const name of ["gardener-check.yml", "gardener-sync.yml", "gardener-task.yml"]) {
      const content = await readFile(join(import.meta.dirname, "../../../.github/workflows", name), "utf8");
      expect(content.includes(GENERATED_MARKER), name).toBe(false);
    }
  });

  it("rejects a sync workflow name outside the gardener- prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-sync-bad-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    const projectPath = join(root, ".gardener/gardener.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    for (const name of ["sync.yml", "gardener-sync.yml/../x.yml", "../gardener-x.yml", `gardener-${"a".repeat(60)}.yml`]) {
      await writeFile(projectPath, JSON.stringify({ ...project, syncWorkflow: name }));
      await expect(buildProject({ repositoryRoot: root })).rejects.toThrow(/syncWorkflow must be a file name/);
    }
  });
});

describe("reactions", () => {
  // A release after 0.1.12, whose task workflow takes the reactions input.
  const REACTING_REF = `scuffi/gardener/.github/workflows/gardener-task.yml@${"a".repeat(40)}`;

  async function render(task: string, workflowRef = REACTING_REF): Promise<{ text: string; parsed: any; hash: string }> {
    const root = await mkdtemp(join(tmpdir(), "gardener-project-reactions-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    const projectPath = join(root, ".gardener/gardener.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    await writeFile(projectPath, JSON.stringify({ ...project, handle: "gardener-bot", release: { workflowRef } }));
    await mkdir(join(root, ".gardener/tasks/t"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/t/TASK.md"), task);
    const built = await buildProject({ repositoryRoot: root });
    const text = await readFile(join(root, built.tasks[0]!.workflow), "utf8");
    return { text, parsed: parseYaml(text), hash: built.tasks[0]!.bundleHash };
  }

  const COMMENT_TASK = TASK.replace(
    /trigger:[\s\S]*?tools:/,
    "triggers:\n  - event: github.issue_comment.created\n    mentions: [self]\n    authors: [maintainers, renovate-bot]\n  - event: github.schedule\n    cron: 0 6 * * 1\ntools:",
  );

  it("reacts to the triggering issue for any author", async () => {
    const { parsed } = await render(TASK.replace("  labels-all:\n    - gardener-example\n", "  authors: any\n"));
    expect(parsed.jobs.gardener.with.reactions).toBe("${{ (github.event_name == 'issues' && github.event.action == 'opened') }}");
    expect(parsed.jobs.gardener.permissions.issues).toBe("write");
  });

  it("reacts only for the authors a task admits, and not to schedules", async () => {
    const { parsed } = await render(COMMENT_TASK);
    expect(parsed.jobs.gardener.with.reactions).toBe(
      "${{ (github.event_name == 'issue_comment' && github.event.action == 'created' && "
        + "(contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.comment.author_association) "
        + "|| github.event.comment.user.login == 'renovate-bot')) }}",
    );
  });

  it("leaves reactions out when the task turns them off, without changing other bundles' hashes", async () => {
    const quiet = TASK.replace("tools:", "reactions: false\ntools:").replace("effects:\n  - issue.comment.create\n", "");
    const { parsed, text } = await render(quiet);
    expect(text).not.toContain("reactions:");
    expect(parsed.jobs.gardener.permissions.issues).toBe("read");
    // Saying the default out loud changes nothing.
    expect((await render(TASK.replace("tools:", "reactions: true\ntools:"))).hash).toBe((await render(TASK)).hash);
  });

  it("passes no reactions input to a release whose workflow does not define it", async () => {
    const { text } = await render(TASK, "scuffi/gardener/.github/workflows/gardener-task.yml@868542c32a2a0684ded8cc1be3d6b2cfa1b0d62d");
    expect(text).not.toContain("reactions:");
  });
});

describe("authors lists, opened-by and pull request head checkout", () => {
  const REVIEW_TASK = TASK
    .replace("id: example-task", "id: review-fix")
    .replace(
      "trigger:\n  event: github.issue.opened\n  labels-all:\n    - gardener-example",
      "checkout: pull-request-head\ntrigger:\n  event: github.pull_request_review.submitted\n"
        + "  authors: [\"Devin-AI-Integration[bot]\", maintainers, \"devin-ai-integration[bot]\"]\n  opened-by:\n    - GitHub-Actions[bot]",
    )
    .replace("effects:\n  - issue.comment.create", "effects:\n  - commit.create\n  - pull_request.comment.create");
  const withTrigger = (trigger: string) => TASK.replace(
    "trigger:\n  event: github.issue.opened\n  labels-all:\n    - gardener-example",
    `trigger:\n${trigger}`,
  );

  it("normalises authors lists and opened-by to sorted, unique, lower-case logins", async () => {
    const { bundle } = await compileTaskSource(REVIEW_TASK);
    expect(bundle.checkout).toBe("pull-request-head");
    expect(bundle.triggers.find((trigger) => trigger.kind === "github.pull_request_review.submitted")).toMatchObject({
      authors: ["devin-ai-integration[bot]", "maintainers"],
      openedBy: ["github-actions[bot]"],
    });
  });

  it("keeps existing bundles identical: a list of only maintainers is the scalar", async () => {
    const scalar = await compileTaskSource(withTrigger("  event: github.issue_comment.created\n  authors: maintainers"));
    const list = await compileTaskSource(withTrigger("  event: github.issue_comment.created\n  authors: [Maintainers]"));
    expect(list.bundleHash).toBe(scalar.bundleHash);
  });

  it("refuses any inside a list and entries that are not logins", async () => {
    await expect(compileTaskSource(withTrigger("  event: github.issue_comment.created\n  authors: [any, maintainers]")))
      .rejects.toThrow(/any cannot be combined/);
    await expect(compileTaskSource(withTrigger("  event: github.issue_comment.created\n  authors: [\"not a login\"]")))
      .rejects.toThrow(/not maintainers or a GitHub login/);
  });

  it("refuses opened-by where the opener is the author, or where there is no thread", async () => {
    for (const event of ["github.issue.opened", "github.pull_request.opened", "github.pull_request.edited", "github.discussion.created"]) {
      await expect(compileTaskSource(withTrigger(`  event: ${event}\n  opened-by: [\"github-actions[bot]\"]`)))
        .rejects.toThrow(/the opener is the author; use authors/);
    }
    await expect(compileTaskSource(withTrigger("  event: github.push\n  branches: [main]\n  opened-by: [someone]")))
      .rejects.toThrow(/opened-by is not supported by github.push/);
    await expect(compileTaskSource(withTrigger("  event: github.pull_request.labeled\n  labels-all: [ship]\n  opened-by: [\"Dependabot[bot]\"]")))
      .resolves.toMatchObject({ bundle: { triggers: expect.arrayContaining([expect.objectContaining({ openedBy: ["dependabot[bot]"] })]) } });
  });

  it("refuses pull request head checkout without a pull request trigger", async () => {
    await expect(compileTaskSource(`---\ncheckout: pull-request-head\n${TASK.slice(4)}`))
      .rejects.toThrow(/checkout: pull-request-head needs a pull request trigger/);
  });

  it("renders the opener prefilter, the head checkout and one round per pull request", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-review-rounds-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    await mkdir(join(root, ".gardener/tasks/review-fix"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/review-fix/TASK.md"), REVIEW_TASK);
    const built = await buildProject({ repositoryRoot: root });
    const workflow = await readFile(join(root, built.tasks[0]!.workflow), "utf8");
    expect(workflow).toContain(
      "(github.event_name == 'pull_request_review' && github.event.action == 'submitted' "
      + "&& github.event.pull_request.head.repo.full_name == github.repository "
      + "&& github.event.pull_request.user.login == 'github-actions[bot]')",
    );
    // The manual trigger keeps its own clause, untouched by the pull request guards.
    expect(workflow).toContain("|| github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("    concurrency:\n      group: gardener-review-fix-${{ github.event.pull_request.number || github.run_id }}\n      cancel-in-progress: false\n");
    expect(workflow).toContain("      checkout-ref: ${{ github.event.pull_request.head.sha }}\n");
    expect(() => parseYaml(workflow)).not.toThrow();
  });

  it("adds no concurrency or head checkout to tasks that did not ask for it", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-review-rounds-plain-"));
    await initializeProject({ repositoryRoot: root, demos: false });
    await mkdir(join(root, ".gardener/tasks/example"), { recursive: true });
    await writeFile(join(root, ".gardener/tasks/example/TASK.md"), TASK);
    const built = await buildProject({ repositoryRoot: root });
    const workflow = await readFile(join(root, built.tasks[0]!.workflow), "utf8");
    expect(workflow).not.toContain("concurrency:");
    expect(workflow).not.toContain("checkout-ref");
  });
});

describe("task-writing guide", () => {
  it("is written by init, kept out of the checked files, and restored by generate", async () => {
    const root = await mkdtemp(join(tmpdir(), "gardener-guide-"));
    await initializeProject({ repositoryRoot: root, demos: true });
    const path = join(root, TASK_GUIDE_PATH);
    const guide = await readFile(path, "utf8");
    const { version } = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(guide).toContain(`npx @scuffi/gardener@${version} generate`);
    expect(guide).not.toContain("{{version}}");

    expect((await buildProject({ repositoryRoot: root })).guidePath).toBeUndefined();
    await writeFile(path, "edited\n");
    // A stale guide never fails the pull request check or the sync.
    expect(await staleProjectFiles(await planProject({ repositoryRoot: root }))).toEqual([]);
    expect((await buildProject({ repositoryRoot: root })).guidePath).toBe(path);
    expect(await readFile(path, "utf8")).toBe(guide);
  });

  it("names every trigger, tool and effect, and its template compiles", async () => {
    const guide = await renderTaskGuide();
    const rows = guide.split("\n").filter((line) => line.startsWith("|"));
    for (const kind of taskTriggerKindValues) {
      const family = kind.slice(0, kind.lastIndexOf("."));
      const action = kind.slice(kind.lastIndexOf(".") + 1);
      expect(rows.some((row) => row.includes(`\`${family}.`)
        && (row.includes(`\`${kind}\``) || row.includes(`\`.${action}\``))), kind).toBe(true);
    }
    for (const tool of taskToolV1Schema.options) expect(guide, tool).toContain(`\`${tool}\``);
    for (const kind of operationKindValues) expect(guide, kind).toContain(`\`${kind}\``);

    const template = /## Template\n\n```markdown\n([\s\S]*?)\n```\n/.exec(guide)?.[1];
    expect(template).toBeDefined();
    await expect(compileTaskSource(`${template}\n`, "SKILL.md")).resolves.toBeDefined();
  });
});
