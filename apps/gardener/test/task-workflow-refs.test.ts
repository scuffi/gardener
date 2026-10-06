import { describe, expect, it } from "vitest";
import { releaseMismatchAdvice, trustedTaskWorkflowRefs } from "../src/task-runtime/workflow-refs";

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
