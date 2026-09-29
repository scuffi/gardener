import { describe, expect, it } from "vitest";
import { trustedTaskWorkflowRefs } from "../src/task-runtime/workflow-refs";

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
