import { describe, expect, it } from "vitest";
import { operationKindValues } from "../src/operations";
import {
  normalizedEventV1Schema,
  pullRequestFamilyTriggerKindValues,
  taskBundleV1Schema,
  taskEffectKindV1Schema,
  taskOutcomeV1Schema,
  taskRunRequestV1Schema,
  taskToolResultV1Schema,
  taskToolV1Schema,
  taskTriggerKindValues,
  taskTriggerV1Schema,
  type NormalizedEventV1,
  type TaskBundleV1,
} from "../src/task";

const hash = "a".repeat(64);

function fixtureBundle(): TaskBundleV1 {
  return {
    schemaVersion: "gardener.task-bundle/v1",
    model: "@cf/moonshotai/kimi-k2.6",
    taskId: "fixture.inspect",
    name: "Fixture repository inspection",
    description: "Inspect repository state and return a structured report.",
    instructions: "Inspect the checked-out repository. Report only evidence obtained through declared tools.",
    triggers: [{ kind: "github.workflow_dispatch" }],
    tools: ["repository.list_files", "repository.read_file", "repository.exec"],
    effects: [],
    network: { default: "deny", allow: [], deny: [] },
    limits: {
      runtimeSeconds: 300,
      maxTurns: 8,
      maxToolCalls: 24,
      inputTokens: 64_000,
      outputTokens: 8_000,
    },
  };
}

function fixtureEvent(): NormalizedEventV1 {
  return {
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "event:fixture:1",
    kind: "github.workflow_dispatch",
    occurredAt: "2026-09-17T12:00:00.000Z",
    repository: {
      id: "1374842705",
      ownerId: "45369682",
      owner: "scuffi",
      name: "gardener-actions-v1-public-smoke",
      fullName: "scuffi/gardener-actions-v1-public-smoke",
      visibility: "public",
      commitSha: "b".repeat(40),
      ref: "refs/heads/main",
      defaultBranch: "main",
    },
    workflow: {
      runId: "35256179260",
      runAttempt: 1,
      eventName: "workflow_dispatch",
      workflowRef: "scuffi/gardener-actions-v1-public-smoke/.github/workflows/gardener.yml@refs/heads/main",
      jobWorkflowRef: "scuffi/gardener-actions-v1-public-smoke/.github/workflows/gardener-reusable.yml@" + "c".repeat(40),
      runnerEnvironment: "github-hosted",
    },
    actor: { id: "45369682", login: "scuffi" },
    prompt: "Inspect this repository.",
  };
}

describe("Actions-native task v1 contracts", () => {
  it("accepts a repository-independent fixture bundle and rejects hidden authority", () => {
    expect(taskBundleV1Schema.parse(fixtureBundle())).toEqual(fixtureBundle());
    expect(() => taskBundleV1Schema.parse({ ...fixtureBundle(), githubToken: "secret" })).toThrow();
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      tools: [...fixtureBundle().tools, "github.issue.comment"],
    })).toThrow();
  });

  it("validates portable network defaults and exact/wildcard host rules", () => {
    expect(taskBundleV1Schema.parse({
      ...fixtureBundle(),
      network: {
        default: "deny",
        allow: ["api.github.com", "*.example.com"],
        deny: ["telemetry.example.com"],
      },
    }).network).toEqual({
      default: "deny",
      allow: ["api.github.com", "*.example.com"],
      deny: ["telemetry.example.com"],
    });
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      network: { default: "deny", allow: ["https://api.github.com/path"], deny: [] },
    })).toThrow(/hostname/);
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      network: { default: "deny", allow: ["api.github.com", "api.github.com"], deny: [] },
    })).toThrow(/unique/);
  });

  it("requires unique trigger, tool, and effect declarations", () => {
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      tools: ["repository.exec", "repository.exec"],
    })).toThrow(/unique/);
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      triggers: [{ kind: "github.workflow_dispatch" }, { kind: "github.workflow_dispatch" }],
    })).toThrow(/unique/);
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      triggers: [
        { kind: "github.issue.opened", labelsAll: ["a"], mentions: [], authors: "any" },
        { kind: "github.issue.opened", labelsAll: ["b"], mentions: [], authors: "any" },
      ],
    })).toThrow(/unique/);
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      effects: ["issue.comment.create", "issue.comment.create"],
    })).toThrow(/unique/);
  });

  it("exposes exactly the persistent provider operations as effect authority", () => {
    expect(taskEffectKindV1Schema.options).toEqual([...operationKindValues]);
    expect(taskEffectKindV1Schema.options).toHaveLength(29);
    expect(taskBundleV1Schema.parse({
      ...fixtureBundle(),
      effects: [...operationKindValues],
    }).effects).toEqual([...operationKindValues]);
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      effects: ["issue.labels.update"],
    })).toThrow();
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      effects: ["issue.*"],
    })).toThrow();
  });

  it("declares the read-only provider API tool alongside repository tools", () => {
    expect(taskToolV1Schema.options).toEqual([
      "repository.read_file",
      "repository.list_files",
      "repository.exec",
      "provider.api.read",
    ]);
    expect(taskBundleV1Schema.parse({
      ...fixtureBundle(),
      tools: ["provider.api.read"],
    }).tools).toEqual(["provider.api.read"]);
  });

  it("keeps the declared trigger kind list aligned with the discriminated union", () => {
    const unionKinds = taskTriggerV1Schema.options.map((option) => option.shape.kind.value);
    expect([...taskTriggerKindValues]).toEqual(unionKinds);
    expect(taskTriggerKindValues).toHaveLength(29);
    expect(taskTriggerKindValues).not.toContain("github.pull_request_target");
    expect(pullRequestFamilyTriggerKindValues).toEqual([
      "github.pull_request.opened",
      "github.pull_request.reopened",
      "github.pull_request.synchronize",
      "github.pull_request.ready_for_review",
      "github.pull_request.converted_to_draft",
      "github.pull_request.edited",
      "github.pull_request.labeled",
      "github.pull_request.unlabeled",
      "github.pull_request_review.submitted",
      "github.pull_request_review_comment.created",
      "github.pull_request_review_comment.edited",
    ]);
  });

  it("validates push branch filters and schedule cron expressions", () => {
    expect(taskBundleV1Schema.parse({
      ...fixtureBundle(),
      triggers: [{ kind: "github.push", branches: ["main", "release/*"] }, { kind: "github.workflow_dispatch" }],
    }).triggers).toEqual([{ kind: "github.push", branches: ["main", "release/*"] }, { kind: "github.workflow_dispatch" }]);
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      triggers: [{ kind: "github.push", branches: [] }],
    })).toThrow();
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      triggers: [{ kind: "github.push" }],
    })).toThrow();
    expect(taskBundleV1Schema.parse({
      ...fixtureBundle(),
      triggers: [{ kind: "github.workflow_dispatch" }, { kind: "github.schedule", cron: "0 3 * * 1" }],
    }).triggers).toEqual([{ kind: "github.workflow_dispatch" }, { kind: "github.schedule", cron: "0 3 * * 1" }]);
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      triggers: [{ kind: "github.schedule", cron: "0 3 * *" }],
    })).toThrow(/cron/);
  });

  it("requires a model and accepts any AI Gateway model id", () => {
    const { model: _omitted, ...withoutModel } = fixtureBundle();
    expect(() => taskBundleV1Schema.parse(withoutModel)).toThrow();
    for (const model of ["@cf/moonshotai/kimi-k2.6", "openai/gpt-5.1", "anthropic/claude-haiku-4-5", "google-ai-studio/gemini-2.5-flash", "workers-ai/@cf/zai-org/glm-5.2"]) {
      expect(taskBundleV1Schema.parse({ ...fixtureBundle(), model }).model).toBe(model);
    }
    for (const model of ["", " openai/gpt-5.1", "openai/gpt 5", "/openai/gpt-5.1", "openai/gpt-5.1\n", "x".repeat(257), "openai/../foo", "anthropic//x", "@cf/x/", "./x", "cloudflare/openai/gpt-5.1"]) {
      expect(() => taskBundleV1Schema.parse({ ...fixtureBundle(), model })).toThrow();
    }
  });

  it("requires the manual trigger and accepts draft only as true", () => {
    const issueOnly = { ...fixtureBundle(), triggers: [{ kind: "github.issue.opened", labelsAll: [], mentions: [], authors: "any" }] };
    expect(() => taskBundleV1Schema.parse(issueOnly)).toThrow(/github.workflow_dispatch/);
    expect(taskBundleV1Schema.parse({ ...fixtureBundle(), draft: true }).draft).toBe(true);
    expect(() => taskBundleV1Schema.parse({ ...fixtureBundle(), draft: false })).toThrow();
  });

  it("carries no fork-execution opt-in and fails closed on fork head revisions", () => {
    expect(Object.keys(fixtureBundle())).not.toContain("allowForkExecution");
    expect(() => taskBundleV1Schema.parse({ ...fixtureBundle(), allowForkExecution: true })).toThrow();
  });


  it("treats effect-plan ceilings as optional and omits them when unset", () => {
    expect(fixtureBundle().limits.maxEffectOperations).toBeUndefined();
    const bounded = taskBundleV1Schema.parse({
      ...fixtureBundle(),
      limits: { ...fixtureBundle().limits, maxEffectOperations: 12, maxEffectBytes: 262_144 },
    });
    expect(bounded.limits).toMatchObject({ maxEffectOperations: 12, maxEffectBytes: 262_144 });
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      limits: { ...fixtureBundle().limits, maxEffectOperations: 0 },
    })).toThrow();
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      limits: { ...fixtureBundle().limits, maxEffectBytes: 512 },
    })).toThrow();
  });

  it("binds normalized events to numeric GitHub identity and hosted workflow context", () => {
    expect(normalizedEventV1Schema.parse(fixtureEvent())).toEqual(fixtureEvent());
    expect(() => normalizedEventV1Schema.parse({
      ...fixtureEvent(),
      repository: { ...fixtureEvent().repository, ownerId: "scuffi" },
    })).toThrow();
    expect(() => normalizedEventV1Schema.parse({
      ...fixtureEvent(),
      workflow: { ...fixtureEvent().workflow, runnerEnvironment: "self-hosted" },
    })).toThrow();
  });

  it("defines one immutable bundle/event/model/deadline run request", () => {
    const request = {
      schemaVersion: "gardener.task-run-request/v1",
      runId: "run:fixture:1",
      bundle: fixtureBundle(),
      bundleHash: hash,
      sourcePath: ".gardener/tasks/fixture.inspect/TASK.md",
      policySnapshotHash: "d".repeat(64),
      event: fixtureEvent(),
      model: { id: "@cf/test/model" },
      admittedAt: "2026-09-17T12:00:00.000Z",
      deadlineAt: "2026-09-17T12:05:00.000Z",
    } as const;
    expect(taskRunRequestV1Schema.parse(request)).toEqual(request);
    expect(() => taskRunRequestV1Schema.parse({
      ...request,
      deadlineAt: request.admittedAt,
    })).toThrow(/deadline/);
  });

  it("keeps shell results structured and process-state consistent", () => {
    const result = {
      schemaVersion: "gardener.task-tool-result/v1",
      operationId: "run:fixture:1:operation:1",
      tool: "repository.exec",
      status: "completed",
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      outputTruncated: false,
    } as const;
    expect(taskToolResultV1Schema.parse(result)).toEqual(result);
    expect(() => taskToolResultV1Schema.parse({ ...result, status: "timed_out", exitCode: 0 })).toThrow(/exitCode/);
  });

  it("accepts the first inspect-only structured outcome with no proposed effects", () => {
    const outcome = {
      schemaVersion: "gardener.task-outcome/v1",
      runId: "run:fixture:1",
      taskId: fixtureBundle().taskId,
      bundleHash: hash,
      status: "completed",
      summary: "The repository contains a README and its smoke workflow is configured.",
      observations: [{ kind: "repository", summary: "README.md was inspected.", paths: ["README.md"] }],
      proposedEffects: [],
    } as const;
    expect(taskOutcomeV1Schema.parse(outcome)).toEqual(outcome);
    expect(() => taskOutcomeV1Schema.parse({ ...outcome, providerReceipt: { id: "not-allowed" } })).toThrow();
  });
});
