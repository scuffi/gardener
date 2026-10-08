import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  operationKindValues,
  operationOutputNames,
  taskToolV1Schema,
  taskTriggerKindValues,
  type OperationKind,
} from "@gardener/contracts";
import { OPERATION_TOKEN_PERMISSIONS } from "@gardener/provider-github";
import { compileTaskSource, effectFamilyGlobValues, expandEffectSelectors } from "../src/task-authoring";

// Keeps the generated parts of the reference docs in step with the code. Regenerate them with:
//   UPDATE_DOCS=1 pnpm --filter @scuffi/gardener exec vitest run test/docs.test.ts
const ROOT = join(import.meta.dirname, "../../..");
const UPDATE = process.env.UPDATE_DOCS === "1";

/** What each effect kind does, in one line. Every kind needs one. */
const EFFECT_DESCRIPTIONS: Record<OperationKind, string> = {
  "issue.label.add": "Add an existing label to an issue.",
  "issue.label.remove": "Remove a label from an issue.",
  "issue.comment.create": "Comment on an issue.",
  "issue.comment.update": "Edit a comment on an issue.",
  "issue.close": "Close an issue.",
  "issue.reopen": "Reopen an issue.",
  "issue.assignee.add": "Assign someone to an issue.",
  "issue.assignee.remove": "Unassign someone from an issue.",
  "issue.create": "Open an issue, optionally with labels and assignees.",
  "pull_request.comment.create": "Comment on a pull request's conversation.",
  "pull_request.comment.update": "Edit a comment on a pull request's conversation.",
  "pull_request.review.submit": "Submit a review, optionally with line comments.",
  "pull_request.reviewer.request": "Request reviewers.",
  "pull_request.reviewer.remove": "Remove requested reviewers.",
  "pull_request.update": "Change a pull request's title, body, state or draft status.",
  "pull_request.label.add": "Add an existing label to a pull request.",
  "pull_request.label.remove": "Remove a label from a pull request.",
  "pull_request.update_branch": "Update a pull request with its base, by rebase or merge.",
  "pull_request.review_comment.reply": "Reply in a review thread on the triggering pull request.",
  "pull_request.review_thread.resolve": "Resolve a review thread on the triggering pull request.",
  "branch.create": "Create a branch.",
  "commit.create": "Commit the files the task changed in its checkout.",
  "pull_request.open": "Open a pull request, ready for review.",
  "pull_request.open_draft": "Open a draft pull request.",
  "pull_request.merge": "Merge a pull request after verifying its checks.",
  "discussion.comment.create": "Comment on a discussion.",
  "discussion.comment.update": "Edit a comment on a discussion.",
  "discussion.answer.mark": "Mark a comment as the discussion's answer.",
  "discussion.answer.unmark": "Unmark a discussion's answer.",
  "discussion.close": "Close a discussion.",
  "discussion.reopen": "Reopen a discussion.",
  "check.rerun": "Re-run a GitHub Actions check run.",
  "release.create": "Create a release.",
  "release.update": "Edit a release.",
  "release.publish": "Publish a draft release.",
  "release.delete": "Delete a release.",
};

/** A value each trigger filter accepts, used to probe which kinds take it. */
const FILTER_PROBES = {
  "labels-all": "[probe]",
  mentions: "[probe-bot]",
  authors: "any",
  "opened-by": "[probe]",
  branches: "[main]",
  cron: "\"0 3 * * 1\"",
} as const;
type Filter = keyof typeof FILTER_PROBES;
const FILTERS = Object.keys(FILTER_PROBES) as Filter[];

function probeTask(event: string, filters: readonly Filter[]): string {
  const lines = filters.map((filter) => `  ${filter}: ${FILTER_PROBES[filter]}`);
  return [
    "---",
    "schema: gardener.task/v1",
    "id: probe",
    "name: Probe",
    "description: Probe.",
    "trigger:",
    `  event: ${event}`,
    ...lines,
    "tools: [repository.read_file]",
    "network: { default: deny, allow: [], deny: [] }",
    "limits: { runtime-seconds: 300, max-turns: 8, max-tool-calls: 8, input-tokens: 60000, output-tokens: 16000 }",
    "---",
    "Probe.",
    "",
  ].join("\n");
}

async function compiles(event: string, filters: readonly Filter[]): Promise<boolean> {
  try {
    await compileTaskSource(probeTask(event, filters));
    return true;
  } catch {
    return false;
  }
}

async function renderTriggers(): Promise<string> {
  const rows = ["| Kind | Filters |", "| --- | --- |"];
  for (const event of taskTriggerKindValues) {
    const bare = await compiles(event, []);
    const accepted: string[] = [];
    for (const filter of FILTERS) {
      if (await compiles(event, [filter])) accepted.push(bare ? `\`${filter}\`` : `\`${filter}\` (required)`);
    }
    rows.push(`| \`${event}\` | ${accepted.join(", ") || "none"} |`);
  }
  return rows.join("\n");
}

function renderFamilies(): string {
  const rows = ["| Glob | Expands to |", "| --- | --- |"];
  for (const glob of effectFamilyGlobValues) {
    rows.push(`| \`${glob}\` | ${expandEffectSelectors([glob]).map((kind) => `\`${kind}\``).join(", ")} |`);
  }
  return rows.join("\n");
}

function renderEffects(): string {
  const rows = ["| Kind | Does | Write scopes | Outputs |", "| --- | --- | --- | --- |"];
  for (const kind of operationKindValues) {
    const writes = OPERATION_TOKEN_PERMISSIONS[kind]
      .filter((scope) => scope.endsWith(":write"))
      .map((scope) => `\`${scope.replace(":write", "")}\``);
    const outputs = operationOutputNames(kind).map((name) => `\`${name}\``);
    rows.push(`| \`${kind}\` | ${EFFECT_DESCRIPTIONS[kind]} | ${writes.join(", ")} | ${outputs.join(", ")} |`);
  }
  return rows.join("\n");
}

const CLI = join(ROOT, "packages/cli/dist/cli.js");
const CLI_COMMANDS = ["init", "generate", "deploy", "connect", "upgrade", "yolo", "doctor", "debug", "tasks"];

function help(args: readonly string[]): string {
  return execFileSync(process.execPath, [CLI, ...args, "--help"], { encoding: "utf8" }).trimEnd();
}

function renderCli(): string {
  const sections = [`\`\`\`text\n${help([])}\n\`\`\``];
  for (const command of CLI_COMMANDS) {
    const text = help([command]);
    const title = text.split("\n", 1)[0]!.replace(/^gardener /, "");
    sections.push(`### \`${title}\`\n\n\`\`\`text\n${text}\n\`\`\``);
  }
  return sections.join("\n\n");
}

/** Replaces, or checks, the block between `<!-- generated:name -->` and `<!-- /generated:name -->`. */
function syncBlock(file: string, name: string, body: string): void {
  const path = join(ROOT, file);
  const text = readFileSync(path, "utf8");
  const open = `<!-- generated:${name} -->\n`;
  const close = `<!-- /generated:${name} -->`;
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  expect(start, `${file} is missing ${open.trim()}`).toBeGreaterThanOrEqual(0);
  expect(end, `${file} is missing ${close}`).toBeGreaterThan(start);
  const current = text.slice(start + open.length, end);
  const expected = `${body}\n`;
  if (UPDATE) {
    writeFileSync(path, text.slice(0, start + open.length) + expected + text.slice(end));
    return;
  }
  expect(current, `${file} ${name} is out of date: run UPDATE_DOCS=1 (see test/docs.test.ts)`).toBe(expected);
}

describe("reference docs", () => {
  it("describes every effect kind", () => {
    expect(Object.keys(EFFECT_DESCRIPTIONS).sort()).toEqual([...operationKindValues].sort());
  });

  it("lists every tool", () => {
    const reference = readFileSync(join(ROOT, "docs/task-reference.md"), "utf8");
    for (const tool of taskToolV1Schema.options) expect(reference).toContain(`| \`${tool}\` |`);
  });

  it("has an up-to-date trigger table", async () => {
    syncBlock("docs/task-reference.md", "triggers", await renderTriggers());
  });

  it("has up-to-date effect tables", () => {
    syncBlock("docs/task-reference.md", "families", renderFamilies());
    syncBlock("docs/task-reference.md", "effects", renderEffects());
  });

  it("has an up-to-date CLI reference", () => {
    syncBlock("docs/cli.md", "commands", renderCli());
  });
});
