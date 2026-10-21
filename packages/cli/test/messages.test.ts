import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildProject, initializeProject } from "../src/project";
import { compileTaskSource, expandEffectSelectors, messageWarnings } from "../src/task-authoring";
import { compileGitHubActionsTask } from "../src/actions-target";

const NEW_REF = `scuffi/gardener/.github/workflows/gardener-task.yml@${"a".repeat(40)}`;
/** 0.1.17's task workflow, which declares no chat-webhook secret. */
const PIN_0_1_17 = "scuffi/gardener/.github/workflows/gardener-task.yml@5c9c136ffd6b2e545f398dc413a60e04b66da406";

const task = (effects: string, options: { authors?: string; tools?: string; network?: string } = {}) => `---
schema: gardener.task/v1
id: notify
name: Notify
description: Posts high-priority issues to chat.
trigger:
  event: github.issue.opened
${options.authors === undefined ? "" : `  authors: ${options.authors}\n`}tools:
${options.tools ?? "  - repository.read_file"}
effects:
${effects}
network:
${options.network ?? "  default: deny\n  allow: []\n  deny: []"}
limits:
  runtime-seconds: 120
  max-turns: 4
  max-tool-calls: 8
  input-tokens: 12000
  output-tokens: 1200
---
Post the issue if it is urgent.
`;

async function build(source: string, workflowRef = NEW_REF) {
  const root = await mkdtemp(join(tmpdir(), "gardener-messages-"));
  await initializeProject({ repositoryRoot: root, demos: false });
  const projectPath = join(root, ".gardener/gardener.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  await writeFile(projectPath, JSON.stringify({ ...project, release: { workflowRef } }));
  await mkdir(join(root, ".gardener/tasks/notify"), { recursive: true });
  await writeFile(join(root, ".gardener/tasks/notify/TASK.md"), source);
  const built = await buildProject({ repositoryRoot: root });
  return { built, workflow: await readFile(join(root, built.tasks[0]!.workflow), "utf8") };
}

describe("message.send authoring", () => {
  it("is an exact effect entry, never part of a glob", async () => {
    expect((await compileTaskSource(task("  - message.send"))).bundle.effects).toEqual(["message.send"]);
    await expect(compileTaskSource(task("  - message.*"))).rejects.toThrow();
    expect(expandEffectSelectors(["issue.*", "pull_request.*", "git.*", "discussion.*", "check.*", "release.*"])).not.toContain("message.send");
    expect(expandEffectSelectors(["issue.*", "message.send"])).toContain("message.send");
  });

  it("is refused beside repository.exec", async () => {
    const source = task("  - message.send", { tools: "  - repository.exec", network: "  default: allow\n  allow: []\n  deny: []" });
    const { bundle } = await compileTaskSource(source);
    expect(() => compileGitHubActionsTask(bundle)).toThrow(
      "Task notify declares both message.send and repository.exec; a task that posts messages may not run commands. Split it into two tasks",
    );
    await expect(build(source)).rejects.toThrow(/message\.send and repository\.exec/);
  });
});

describe("message.send callers", () => {
  it("pass the chat webhook secret only for tasks that declare message.send", async () => {
    const { workflow } = await build(task("  - issue.comment.create\n  - message.send"));
    expect(workflow).toContain("    secrets:\n      chat-webhook: ${{ secrets.GARDENER_CHAT_WEBHOOK }}\n");
    const parsed = parseYaml(workflow) as { jobs: { gardener: { secrets: Record<string, string> } } };
    expect(parsed.jobs.gardener.secrets).toEqual({ "chat-webhook": "${{ secrets.GARDENER_CHAT_WEBHOOK }}" });
    expect((await build(task("  - issue.comment.create"))).workflow).not.toContain("secrets");
  });

  it("render a valid caller for a task whose only effect is message.send, with reads on every subject kind", async () => {
    const { bundle } = await compileTaskSource(task("  - message.send"));
    expect(compileGitHubActionsTask(bundle).effectsPermissions).toEqual({
      discussions: "read", "id-token": "write", issues: "read", "pull-requests": "read",
    });
    const { workflow } = await build(task("  - message.send"));
    const parsed = parseYaml(workflow) as { jobs: { gardener: { permissions: Record<string, string>; uses: string } } };
    expect(parsed.jobs.gardener.uses).toBe(NEW_REF);
    expect(parsed.jobs.gardener.permissions).toMatchObject({ discussions: "read", "pull-requests": "read", "id-token": "write" });
    // Reactions on the triggering issue are the only write.
    expect(Object.entries(parsed.jobs.gardener.permissions).filter(([, level]) => level === "write").map(([key]) => key).sort())
      .toEqual(["id-token", "issues"]);
  });

  it("are refused on a pinned workflow that predates the chat webhook secret", async () => {
    await expect(build(task("  - message.send"), PIN_0_1_17)).rejects.toThrow(
      `Task notify declares message.send, which this project's pinned Gardener workflow (${PIN_0_1_17}) cannot run. Run gardener upgrade to pin a release that can.`,
    );
    await expect(build(task("  - issue.comment.create"), PIN_0_1_17)).resolves.toBeDefined();
  });

  it("warn about the secret and private repositories, and about outsiders only when they can start it", async () => {
    const { built } = await build(task("  - message.send"));
    const warnings = built.warnings.filter((warning) => warning.includes("message.send"));
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/^Task notify declares message\.send\. Set the GARDENER_CHAT_WEBHOOK repository secret/);
    expect(warnings[1]).toMatch(/private repository/);
    expect(warnings[2]).toMatch(/not maintainers, so they can cause posts about their own/);
    const maintainers = await compileTaskSource(task("  - message.send", { authors: "maintainers" }));
    expect(messageWarnings(maintainers.bundle)).toHaveLength(2);
    expect(messageWarnings((await compileTaskSource(task("  - issue.comment.create"))).bundle)).toEqual([]);
  });
});
