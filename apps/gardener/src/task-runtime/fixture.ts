import { taskBundleV1Schema, type TaskBundleV1 } from "@gardener/contracts";
import { deepFreeze } from "@gardener/core";

/** Canonical executable fixture used to qualify the runtime before source parsing exists. */
export function inspectRepositoryFixtureBundle(): Readonly<TaskBundleV1> {
  return deepFreeze(taskBundleV1Schema.parse({
    schemaVersion: "gardener.task-bundle/v1",
    taskId: "fixture.issue-triage",
    name: "Issue triage",
    description: "Inspect an opened issue and its repository, then propose one concise triage comment.",
    instructions: [
      "Triage the opened GitHub issue using concrete repository evidence.",
      "Inspect the repository with the declared tools before reaching a conclusion.",
      "Produce one concise, helpful issue comment: summarize what you found, identify likely next steps, and clearly state uncertainty.",
      "Do not modify the repository and do not claim the comment has already been posted.",
    ].join("\n"),
    triggers: [{ kind: "github.issue.opened", labelsAll: ["gardener-test"] }],
    tools: ["repository.list_files", "repository.read_file", "repository.exec"],
    effects: ["issue.comment.create"],
    planningNetwork: "unrestricted",
    limits: {
      runtimeSeconds: 300,
      maxTurns: 8,
      maxToolCalls: 24,
      inputTokens: 64_000,
      outputTokens: 8_000,
    },
  }));
}
