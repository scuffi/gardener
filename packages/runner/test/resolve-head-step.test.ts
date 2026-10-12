import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Runs the reusable workflow's "Resolve current pull request head" script
 * against a stub `gh` that applies the real `--jq` filter to fixture JSON.
 */
const workflow = readFileSync(path.resolve(__dirname, "../../../.github/workflows/gardener-task.yml"), "utf8");

function resolveScript(): string {
  const lines = workflow.split("\n");
  const step = lines.findIndex((line) => line.trim() === "- name: Resolve current pull request head");
  const run = lines.findIndex((line, index) => index > step && line.trim() === "run: |");
  const indent = lines[run + 1]!.length - lines[run + 1]!.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

const eventSha = "d".repeat(40);
const movedSha = "e".repeat(40);
const pull = (overrides: Record<string, unknown> = {}) => ({
  state: "open",
  head: { sha: movedSha, ref: "gardener/fix-12", repo: { id: 1 } },
  base: { repo: { id: 1 } },
  ...overrides,
});

function run(fixture: unknown, options: { fail?: boolean; eventRef?: string; pullNumber?: string } = {}): { sha: string; log: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "gardener-resolve-head-"));
  const fixturePath = path.join(directory, "pull.json");
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const gh = path.join(directory, "gh");
  // gh api <path> --jq <filter>
  writeFileSync(gh, `#!/usr/bin/env bash\nif [ -n "$GH_FAIL" ]; then echo "HTTP 502" >&2; exit 1; fi\nexec jq -r "$4" "${fixturePath}"\n`);
  chmodSync(gh, 0o755);
  const output = path.join(directory, "output");
  writeFileSync(output, "");
  const log = execFileSync("bash", ["-e", "-c", resolveScript()], {
    encoding: "utf8",
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "scuffi/gardener",
      GITHUB_OUTPUT: output,
      EVENT_SHA: eventSha,
      EVENT_REF: options.eventRef ?? "gardener/fix-12",
      PULL_NUMBER: options.pullNumber ?? "12",
      ...(options.fail ? { GH_FAIL: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { sha: /^sha=(.*)$/m.exec(readFileSync(output, "utf8"))?.[1] ?? "", log };
}

describe("resolve current pull request head step", () => {
  it("moves to the current head of an open same-repository pull request on the same branch", () => {
    const result = run(pull());
    expect(result.sha).toBe(movedSha);
    expect(result.log).toContain(`planning on ${movedSha}`);
  });

  it("keeps the event's head for forks, deleted head repositories, closed pull requests and other branches", () => {
    expect(run(pull({ head: { sha: movedSha, ref: "gardener/fix-12", repo: { id: 2 } } })).sha).toBe(eventSha);
    expect(run(pull({ head: { sha: movedSha, ref: "gardener/fix-12", repo: null } })).sha).toBe(eventSha);
    expect(run(pull({ state: "closed" })).sha).toBe(eventSha);
    expect(run(pull({ head: { sha: movedSha, ref: "other", repo: { id: 1 } } })).sha).toBe(eventSha);
  });

  it("compares branch names literally, not as globs", () => {
    expect(run(pull(), { eventRef: "*" }).sha).toBe(eventSha);
    expect(run(pull(), { eventRef: "gardener/*" }).sha).toBe(eventSha);
  });

  it("ignores a head that is not a commit SHA", () => {
    expect(run(pull({ head: { sha: "not-a-sha", ref: "gardener/fix-12", repo: { id: 1 } } })).sha).toBe(eventSha);
  });

  it("warns and keeps the event's head when the lookup fails", () => {
    const result = run(pull(), { fail: true });
    expect(result.sha).toBe(eventSha);
    expect(result.log).toContain("::warning::Could not read pull request #12; planning on the event's head");
  });

  // A comment on a pull request, or a manual run naming one: no event head.
  describe("for a pull request named by number", () => {
    it("plans on the head of an open same-repository pull request", () => {
      const result = run(pull({ head: { sha: movedSha, ref: "any-branch", repo: { id: 1 } } }), { eventRef: "" });
      expect(result.sha).toBe(movedSha);
      expect(result.log).toContain(`Planning on the head of pull request #12, ${movedSha}`);
    });

    it("warns and keeps the default checkout for forks, closed pull requests and failed lookups", () => {
      const warning = "::warning::#12 is closed or from a fork, or could not be read; planning on the default branch";
      for (const fixture of [
        pull({ state: "closed" }),
        pull({ head: { sha: movedSha, ref: "x", repo: { id: 2 } } }),
        pull({ head: { sha: movedSha, ref: "x", repo: null } }),
        pull({ head: { sha: "not-a-sha", ref: "x", repo: { id: 1 } } }),
      ]) {
        const result = run(fixture, { eventRef: "" });
        expect(result.sha).toBe("");
        expect(result.log).toContain(warning);
      }
      const failed = run(pull(), { eventRef: "", fail: true });
      expect(failed.sha).toBe("");
      expect(failed.log).toContain(warning);
    });

    it("refuses anything that is not a pull request number", () => {
      for (const pullNumber of ["0", "12; rm -rf /", "abc", "12345678901"]) {
        const result = run(pull(), { eventRef: "", pullNumber });
        expect(result.sha, pullNumber).toBe("");
        expect(result.log).toContain("is not a pull request number");
      }
    });
  });
});
