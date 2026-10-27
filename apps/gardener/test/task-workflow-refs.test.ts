/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  planCarries,
  releaseMismatchAdvice,
  TASK_WORKFLOWS_WITHOUT,
  trustedTaskWorkflowRefs,
} from "../src/task-runtime/workflow-refs";

const ref = (repository: string, sha: string, file = "gardener-task.yml") => `${repository}/.github/workflows/${file}@${sha.repeat(40)}`;

describe("trusted task workflows", () => {
  it("adds the Worker's release beside the enrolled one", () => {
    expect(trustedTaskWorkflowRefs(ref("scuffi/gardener", "a"), ref("scuffi/gardener", "b")))
      .toEqual([ref("scuffi/gardener", "a"), ref("scuffi/gardener", "b")]);
  });

  it("names the release once when the repository is already on it", () => {
    expect(trustedTaskWorkflowRefs(ref("scuffi/gardener", "a"), ref("scuffi/gardener", "a"))).toEqual([ref("scuffi/gardener", "a")]);
  });

  it("never adds a release from another repository, or a malformed one", () => {
    expect(trustedTaskWorkflowRefs(ref("evil/gardener", "a"), ref("scuffi/gardener", "b"))).toEqual([ref("evil/gardener", "a")]);
    expect(trustedTaskWorkflowRefs(ref("scuffi/gardener", "a"), ref("evil/gardener", "b"))).toEqual([ref("scuffi/gardener", "a")]);
    expect(trustedTaskWorkflowRefs(ref("scuffi/gardener", "a"), "scuffi/gardener/.github/workflows/gardener-task.yml@main"))
      .toEqual([ref("scuffi/gardener", "a")]);
    expect(trustedTaskWorkflowRefs(ref("scuffi/gardener", "a"), undefined)).toEqual([ref("scuffi/gardener", "a")]);
  });

  it("trusts nothing without an enrolled workflow", () => {
    expect(trustedTaskWorkflowRefs(null, ref("scuffi/gardener", "b"))).toEqual([]);
  });
});

describe("releaseMismatchAdvice", () => {
  const runtime = `scuffi/gardener/.github/workflows/gardener-task.yml@${"ab".repeat(20)}`;
  const workflow = `scuffi/gardener/.github/workflows/gardener-sync.yml@${"cd".repeat(20)}`;

  it("names both releases and the command that realigns them", () => {
    expect(releaseMismatchAdvice(runtime, workflow)).toBe(
      "This runtime is on Gardener release abababababab and this workflow is on cdcdcdcdcdcd. Usually the repository was upgraded first: run gardener upgrade --workspace <name> with the Gardener CLI from this workflow's release (cdcdcdcdcdcd), which redeploys the runtime and then moves the repository to it, then rerun.",
    );
    expect(releaseMismatchAdvice(runtime)).toMatch(/^This runtime is on Gardener release abababababab\. Usually .+ from the release this repository is pinned to,/);
  });

  it("tells a missing pin from a malformed one", () => {
    expect(releaseMismatchAdvice(undefined, workflow)).toMatch(/^This runtime has no release pin and this workflow is on cdcdcdcdcdcd\./);
    expect(releaseMismatchAdvice("not-a-ref")).toMatch(/^This runtime's release pin is malformed\./);
  });
});

/**
 * Release-blocking, and a mirror of scripts/check-release-pins.mjs (which also
 * checks each set against what each tag's contracts support): the current
 * release's task workflow must carry every plan field, and every earlier
 * release's must be listed for the fields it lacks. A missing entry breaks
 * every run of that release; a present current one silently drops apply's
 * check of that field for everyone on it.
 */
describe("task workflows without plan capabilities", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const defaultWorkflowRef = (source: string | null) => /DEFAULT_WORKFLOW_REF =\s*"([^"]+)"/.exec(source ?? "")?.[1];
  const current = defaultWorkflowRef(readFileSync(`${root}packages/cli/src/project.ts`, "utf8"));
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
  // Shallow clones (the Check workflow's) have no tags; full history does.
  const tags = (git("tag", "--list", "v*") ?? "").split("\n").filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const releasedRefs = new Set(tags.map((tag) => defaultWorkflowRef(git("show", `${tag}:packages/cli/src/project.ts`))));
  const capabilities = Object.keys(TASK_WORKFLOWS_WITHOUT) as (keyof typeof TASK_WORKFLOWS_WITHOUT)[];

  it("leaves the current release's task workflow out, so its plans carry every field", () => {
    expect(current).toMatch(/\/gardener-task\.yml@[0-9a-f]{40}$/);
    // Until this release's own workflow is pinned, DEFAULT_WORKFLOW_REF still
    // names the previous release's, which lacks the fields this release adds.
    if (releasedRefs.has(current)) return;
    for (const capability of capabilities) {
      expect(
        planCarries(capability, current!),
        `DEFAULT_WORKFLOW_REF (${current}) is an earlier release's workflow: pin this release's gardener-task.yml before releasing`,
      ).toBe(true);
    }
  });

  // The newest capability, which no release before this one has. (It named
  // `messages` until 0.1.18 shipped them; scripts/check-release-pins.mjs checks
  // every capability against each tag's own contracts.)
  it.skipIf(tags.length === 0)("lists every earlier release's task workflow as lacking task runs", () => {
    const released = new Set(releasedRefs);
    released.delete(current);
    expect(released.size).toBeGreaterThan(0);
    for (const ref of released) {
      expect(ref, `a release's DEFAULT_WORKFLOW_REF`).toMatch(/@[0-9a-f]{40}$/);
      expect(planCarries("taskRuns", ref!), `${ref} must be in TASK_WORKFLOWS_WITHOUT.taskRuns`).toBe(false);
    }
  });

  it("only ever adds capabilities: each set contains the earlier one", () => {
    for (const sha of TASK_WORKFLOWS_WITHOUT.effectScope) expect(TASK_WORKFLOWS_WITHOUT.messages.has(sha)).toBe(true);
    for (const sha of TASK_WORKFLOWS_WITHOUT.messages) expect(TASK_WORKFLOWS_WITHOUT.taskRuns.has(sha)).toBe(true);
    // 0.1.19 (and 0.1.20, on the same workflow) shipped `messages` but not `taskRuns`.
    expect(planCarries("messages", `scuffi/gardener/.github/workflows/gardener-task.yml@0d02b66f47cc8802ba14a243dd827bf5555b3469`)).toBe(true);
    expect(planCarries("taskRuns", `scuffi/gardener/.github/workflows/gardener-task.yml@0d02b66f47cc8802ba14a243dd827bf5555b3469`)).toBe(false);
    // 0.1.17 shipped `effectScope` but not `messages`.
    expect(planCarries("effectScope", `scuffi/gardener/.github/workflows/gardener-task.yml@5c9c136ffd6b2e545f398dc413a60e04b66da406`)).toBe(true);
    expect(planCarries("messages", `scuffi/gardener/.github/workflows/gardener-task.yml@5c9c136ffd6b2e545f398dc413a60e04b66da406`)).toBe(false);
  });

  it("keys on the commit, wherever the workflow is pinned from", () => {
    for (const capability of capabilities) {
      const [sha] = TASK_WORKFLOWS_WITHOUT[capability];
      expect(planCarries(capability, `scuffi/gardener/.github/workflows/gardener-task.yml@${sha}`)).toBe(false);
      expect(planCarries(capability, `fork/gardener/.github/workflows/gardener-task.yml@${sha}`)).toBe(false);
      expect(planCarries(capability, `scuffi/gardener/.github/workflows/gardener-task.yml@${"e".repeat(40)}`)).toBe(true);
    }
  });
});
