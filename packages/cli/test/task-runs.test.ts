import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildProject, initializeProject } from "../src/project";
import { compileTaskSource } from "../src/task-authoring";

const NEW_REF = `scuffi/gardener/.github/workflows/gardener-task.yml@${"a".repeat(40)}`;
/** 0.1.19's task workflow (also 0.1.20's), whose apply bridge cannot parse `taskRuns`. */
const PIN_0_1_19 = "scuffi/gardener/.github/workflows/gardener-task.yml@0d02b66f47cc8802ba14a243dd827bf5555b3469";

const task = (id: string, options: { trigger?: string; effects?: string } = {}) => `---
schema: gardener.task/v1
id: ${id}
name: ${id}
description: A task for task.run tests.
triggers:
${options.trigger ?? "  - event: github.issue.opened"}
tools:
  - repository.read_file
effects:
${options.effects ?? "  - issue.comment.create"}
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
Do the thing.
`;

const triage = (targets = "[fix]") => task("triage", { effects: `  - issue.comment.create\n  - task.run: { tasks: ${targets} }` });
const fix = (effects = "  - issue.comment.create") => task("fix", { trigger: "  - event: github.issue.labeled\n    labels-all: [gardener-fix]", effects });

async function build(tasks: Record<string, string>, workflowRef = NEW_REF) {
  const root = await mkdtemp(join(tmpdir(), "gardener-task-runs-"));
  await initializeProject({ repositoryRoot: root, demos: false });
  const projectPath = join(root, ".gardener/gardener.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  await writeFile(projectPath, JSON.stringify({ ...project, release: { workflowRef } }));
  for (const [id, source] of Object.entries(tasks)) {
    await mkdir(join(root, `.gardener/tasks/${id}`), { recursive: true });
    await writeFile(join(root, `.gardener/tasks/${id}/TASK.md`), source);
  }
  const built = await buildProject({ repositoryRoot: root });
  const workflow = async (id: string) => readFile(join(root, `.github/workflows/gardener-${id}.yml`), "utf8");
  return { built, workflow };
}

describe("task.run authoring", () => {
  it("compiles the declaration into sorted, unique effect options", async () => {
    const { bundle } = await compileTaskSource(triage("[fix-ready, fix, fix]"));
    expect(bundle.effects).toContain("task.run");
    expect(bundle.effectOptions).toEqual({ "task.run": { tasks: ["fix", "fix-ready"] } });
  });

  it("refuses a bare task.run, and one naming the task itself", async () => {
    await expect(compileTaskSource(task("triage", { effects: "  - task.run" }))).rejects.toThrow(/task.run must list the tasks it may start/);
    await expect(compileTaskSource(triage("[triage]"))).rejects.toThrow(/may not start itself/);
  });

  it("offers the subject input on a manual-only task with workflow_dispatch: { subject }", async () => {
    const ready = task("fix-ready", { trigger: "  - event: github.workflow_dispatch\n    subject: pull_request" });
    const { bundle } = await compileTaskSource(ready);
    expect(bundle.triggers).toEqual([{ kind: "github.workflow_dispatch", subject: "pull_request" }]);
    await expect(compileTaskSource(task("x", { trigger: "  - event: github.issue.opened\n    subject: issue" }))).rejects.toThrow(/subject is not supported/);
    const { workflow } = await build({ "fix-ready": ready });
    const on = (parseYaml(await workflow("fix-ready")) as { on: { workflow_dispatch: { inputs: Record<string, unknown> } } }).on;
    expect(Object.keys(on.workflow_dispatch.inputs)).toEqual(["prompt", "pull_request"]);
  });
});

describe("task.run in generate", () => {
  it("grants actions: write only to the task that declares task.run, and warns about it", async () => {
    const { built, workflow } = await build({ triage: triage(), fix: fix() });
    const permissions = (text: string) => (parseYaml(text) as { jobs: { gardener: { permissions: Record<string, string> } } }).jobs.gardener.permissions;
    expect(permissions(await workflow("triage")).actions).toBe("write");
    expect(permissions(await workflow("fix")).actions).toBeUndefined();
    expect(built.warnings.some((warning) => warning.startsWith("Task triage declares task.run, so its workflow is granted actions: write"))).toBe(true);
    expect(built.warnings.some((warning) => warning.startsWith("Task fix declares task.run"))).toBe(false);
  });

  it("refuses an unknown target", async () => {
    await expect(build({ triage: triage("[fix]") })).rejects.toThrow(
      "Task triage declares task.run on fix, which is not a task in .gardener/tasks; add it or remove it from task.run",
    );
  });

  it("refuses a target whose workflow takes no input the starting task can name", async () => {
    const pulls = task("review", { trigger: "  - event: github.pull_request.opened" });
    await expect(build({ triage: triage("[review]"), review: pulls })).rejects.toThrow(/review's workflow takes no input for an issue/);
    // A task that opens pull requests can start one on the pull request it opened.
    const opener = task("triage", {
      effects: "  - pull_request.open\n  - task.run: { tasks: [review] }",
    });
    await expect(build({ triage: opener, review: pulls })).resolves.toBeDefined();
  });

  it("refuses cycles, which depth would only cut at runtime", async () => {
    await expect(build({ triage: triage("[fix]"), fix: fix("  - task.run: { tasks: [triage] }") })).rejects.toThrow(
      /^Tasks fix → triage → fix start each other with task\.run/,
    );
    // A chain is not a cycle.
    const ready = task("fix-ready", { trigger: "  - event: github.workflow_dispatch\n    subject: issue" });
    await expect(build({ triage: triage("[fix]"), fix: fix("  - task.run: { tasks: [fix-ready] }"), "fix-ready": ready })).resolves.toBeDefined();
  });

  it("refuses a pin whose apply predates task.run, with advice", async () => {
    await expect(build({ triage: triage(), fix: fix() }, PIN_0_1_19)).rejects.toThrow(
      `Task triage declares task.run, which this project's pinned Gardener workflow (${PIN_0_1_19}) cannot run: its apply step predates it. Run gardener upgrade to pin a release that can.`,
    );
  });
});
