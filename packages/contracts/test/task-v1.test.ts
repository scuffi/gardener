import { describe, expect, it } from "vitest";
import { operationKindValues } from "../src/operations";
import {
  normalizedEventV1Schema,
  parseRunLimit,
  runLimitIssue,
  trustedStarterReasonValues,
  untrustedStarterReasonValues,
  pullRequestFamilyTriggerKindValues,
  TASK_RUNTIME_SECONDS_MAX,
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

  it("exposes exactly the persistent provider operations, plus message.send and task.run, as effect authority", () => {
    expect(taskEffectKindV1Schema.options).toEqual([...operationKindValues, "message.send", "task.run"]);
    expect(operationKindValues).toHaveLength(37);
    // commit.merge_base needs its tool and a trigger whose head it can merge into.
    expect(taskBundleV1Schema.parse({
      ...fixtureBundle(),
      triggers: [{ kind: "github.issue_comment.created", labelsAll: [], mentions: [], authors: "maintainers" }, { kind: "github.workflow_dispatch" }],
      tools: [...fixtureBundle().tools, "repository.merge_base"],
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
      "repository.merge_base",
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

  it("requires at least 16 output tokens per model turn", () => {
    const limits = (outputTokens: number) => ({ ...fixtureBundle(), limits: { ...fixtureBundle().limits, maxTurns: 10, outputTokens } });
    expect(() => taskBundleV1Schema.parse(limits(159))).toThrow(/16 tokens per model turn/);
    expect(taskBundleV1Schema.parse(limits(160)).limits).toMatchObject({ maxTurns: 10, outputTokens: 160 });
  });

  it("caps runtimeSeconds at TASK_RUNTIME_SECONDS_MAX", () => {
    const limits = (runtimeSeconds: number) => ({ ...fixtureBundle(), limits: { ...fixtureBundle().limits, runtimeSeconds } });
    expect(TASK_RUNTIME_SECONDS_MAX).toBe(21_600);
    expect(taskBundleV1Schema.parse(limits(21_600)).limits.runtimeSeconds).toBe(21_600);
    expect(() => taskBundleV1Schema.parse(limits(21_601))).toThrow();
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

  it("carries an optional starter whose trust agrees with its reason", () => {
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
    // A request admitted before the field existed still parses.
    expect(taskRunRequestV1Schema.parse(request)).not.toHaveProperty("starter");
    for (const reason of trustedStarterReasonValues) {
      const starter = { trusted: true, reason };
      expect(taskRunRequestV1Schema.parse({ ...request, starter }).starter).toEqual(starter);
      expect(() => taskRunRequestV1Schema.parse({ ...request, starter: { trusted: false, reason } })).toThrow(/means trusted is true/);
    }
    for (const reason of untrustedStarterReasonValues) {
      const starter = { trusted: false, reason };
      expect(taskRunRequestV1Schema.parse({ ...request, starter }).starter).toEqual(starter);
      expect(() => taskRunRequestV1Schema.parse({ ...request, starter: { trusted: true, reason } })).toThrow(/means trusted is false/);
    }
    expect(() => taskRunRequestV1Schema.parse({ ...request, starter: { trusted: true } })).toThrow();
    expect(() => taskRunRequestV1Schema.parse({ ...request, starter: { trusted: true, reason: "schedule", login: "x" } })).toThrow();
    expect(() => taskRunRequestV1Schema.parse({ ...request, starter: { trusted: true, reason: "admin" } })).toThrow();
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

describe("run limits", () => {
  const withLimits = (limits: Record<string, unknown>) => ({ ...fixtureBundle(), limits: { ...fixtureBundle().limits, ...limits } });

  it("parses every window, with a month of 30 days", () => {
    const windows = { minute: 60, hour: 3_600, day: 86_400, week: 604_800, month: 2_592_000 };
    for (const [window, windowSeconds] of Object.entries(windows)) {
      for (const field of ["runs", "runsPerAuthor"] as const) {
        expect(parseRunLimit(`3/${window}`, field)).toEqual({ count: 3, windowSeconds });
      }
    }
  });

  it("accepts counts from 1 to 99999 and nothing outside them", () => {
    expect(parseRunLimit("1/day", "runs")).toEqual({ count: 1, windowSeconds: 86_400 });
    expect(parseRunLimit("99999/day", "runs")).toEqual({ count: 99_999, windowSeconds: 86_400 });
    for (const value of ["0/day", "100000/day", "01/day", "-1/day"]) {
      expect(() => parseRunLimit(value, "runs"), value).toThrow(/runs must be <count>\/<minute\|hour\|day\|week\|month> with a count from 1 to 99999, for example 50\/day/);
    }
  });

  it("accepts unlimited only per author", () => {
    expect(parseRunLimit("unlimited", "runsPerAuthor")).toBe("unlimited");
    expect(() => parseRunLimit("unlimited", "runs")).toThrow(/runs must be/);
    expect(runLimitIssue("unlimited", "runs")).not.toMatch(/unlimited to turn it off/);
    expect(runLimitIssue("never", "runsPerAuthor")).toMatch(/runsPerAuthor must be .* or unlimited to turn it off, for example 3\/day; got "never"/);
  });

  it("refuses garbage and whitespace", () => {
    for (const value of ["", "3", "3/", "/day", "3/days", "3/Day", "3 /day", " 3/day", "3/day ", "3/day\n", "3/fortnight", "1.5/day", "3/day/day", "Unlimited", " unlimited"]) {
      expect(runLimitIssue(value, "runsPerAuthor"), JSON.stringify(value)).toMatch(/runsPerAuthor must be/);
      expect(runLimitIssue(value, "runs"), JSON.stringify(value)).toMatch(/runs must be/);
    }
  });

  it("names the field as the reader wrote it", () => {
    expect(runLimitIssue("lots", "runsPerAuthor", "limits.runs-per-author")).toMatch(/^limits\.runs-per-author must be/);
  });

  it("are optional bundle limits stored as written", () => {
    expect(taskBundleV1Schema.parse(fixtureBundle()).limits).not.toHaveProperty("runs");
    expect(taskBundleV1Schema.parse(fixtureBundle()).limits).not.toHaveProperty("runsPerAuthor");
    expect(taskBundleV1Schema.parse(withLimits({ runs: "50/day", runsPerAuthor: "unlimited" })).limits)
      .toMatchObject({ runs: "50/day", runsPerAuthor: "unlimited" });
    expect(() => taskBundleV1Schema.parse(withLimits({ runs: "unlimited" }))).toThrow(/runs must be/);
    expect(() => taskBundleV1Schema.parse(withLimits({ runsPerAuthor: "0/day" }))).toThrow(/runsPerAuthor must be/);
    expect(() => taskBundleV1Schema.parse(withLimits({ runs: 50 }))).toThrow();
  });
});

describe("bundle effect scope", () => {
  it("is absent unless set, and can only tighten", () => {
    expect(taskBundleV1Schema.parse(fixtureBundle())).not.toHaveProperty("effectScope");
    expect(taskBundleV1Schema.parse({ ...fixtureBundle(), effectScope: "trigger" }).effectScope).toBe("trigger");
    expect(() => taskBundleV1Schema.parse({ ...fixtureBundle(), effectScope: "repository" })).toThrow();
  });
});
