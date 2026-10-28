import { describe, expect, it } from "vitest";
import {
  MESSAGE_SEND_KIND,
  MESSAGE_SUMMARY_MAX_CHARACTERS,
  isMessageInvisibleCharacter,
  isMessageMarkupCharacter,
  messageFromSendPayload,
  messageSendPayloadJsonSchema,
  messageSendPayloadV1Schema,
  messageSummaryRefusal,
  messageV1Schema,
} from "../src/messages";
import { operationKindValues } from "../src/operations";
import {
  messageTriggerScopeRefusal,
  taskBundleV1Schema,
  taskEffectKindValues,
  taskEffectPlanOperationV1Schema,
  taskEffectPlanV1Schema,
  taskEffectProposalV1Schema,
  taskStepIssues,
} from "../src/task";

const now = "2026-10-21T10:00:00.000Z";
const payload = (overrides: Record<string, unknown> = {}) => ({
  subject: { kind: "issue", number: 2, expectedUpdatedAt: now },
  summary: "Crash on start for every user since the last release.",
  ...overrides,
});
const proposal = (overrides: Record<string, unknown> = {}) => ({
  stepName: "notify",
  kind: MESSAGE_SEND_KIND,
  payload: payload(),
  rationale: "High priority: tell the team.",
  ...overrides,
});
const message = (subject: Record<string, unknown> = { kind: "issue", issueNumber: 2, expectedIssueUpdatedAt: now }) => ({
  channel: "default",
  subject,
  summary: "Crash on start.",
});
function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "gardener.task-effect-plan/v1",
    runId: "run:1",
    taskId: "fixture.triage",
    taskName: "Fixture triage",
    bundleHash: "b".repeat(64),
    repository: { id: "1374842705", fullName: "scuffi/gardener", defaultBranch: "main" },
    provenance: { sourcePath: ".gardener/tasks/triage/TASK.md", commitSha: "a".repeat(40), workflowRunId: "35256179260", workflowRunAttempt: 1 },
    event: { kind: "github.issue.opened", eventName: "issues", action: "opened", resource: { kind: "issue", id: "301", number: 2 }, commentId: null },
    limits: {},
    operations: [],
    ...overrides,
  };
}

describe("message.send vocabulary", () => {
  it("is declarable and proposable, but never an operation kind", () => {
    expect(taskEffectKindValues).toContain("message.send");
    expect(operationKindValues).not.toContain("message.send");
    expect(taskEffectKindValues).toEqual([...operationKindValues, "message.send", "task.run"]);
    expect(taskEffectPlanOperationV1Schema.safeParse({
      stepName: "notify", operationId: "op_1", kind: "message.send", payload: payload(), references: {}, rationale: "r",
    }).success).toBe(false);
  });

  it("can be declared in a bundle's effects", () => {
    const effects = taskBundleV1Schema.shape.effects;
    expect(effects.safeParse(["message.send"]).success).toBe(true);
    expect(effects.safeParse(["message.*"]).success).toBe(false);
  });
});

describe("message summaries", () => {
  it("accepts one plain line up to the limit, counted in code points", () => {
    expect(messageSummaryRefusal("Crash on start.")).toBeUndefined();
    // Judged trimmed, as the schema stores it, whether or not the caller trimmed.
    expect(messageSummaryRefusal("  ")).toBe("summary must not be empty");
    expect(messageSummaryRefusal("")).toBe("summary must not be empty");
    expect(messageSummaryRefusal(` ${"é".repeat(MESSAGE_SUMMARY_MAX_CHARACTERS)} `)).toBeUndefined();
    expect(messageSummaryRefusal("é".repeat(MESSAGE_SUMMARY_MAX_CHARACTERS))).toBeUndefined();
    expect(messageSummaryRefusal("🌱".repeat(MESSAGE_SUMMARY_MAX_CHARACTERS))).toBeUndefined();
    expect(messageSummaryRefusal("🌱".repeat(MESSAGE_SUMMARY_MAX_CHARACTERS + 1))).toMatch(/at most 400/);
    expect(messageSummaryRefusal("")).toMatch(/empty/);
  });

  it("refuses markup, invisible characters and forged markers", () => {
    for (const text of ["a <!channel>", "a > b", "use `x`", "&lt;!channel&gt;", "a & b"]) {
      expect(messageSummaryRefusal(text), text).toMatch(/<, >, & or backticks/);
    }
    for (const character of ["\n", "\r", "\t", "\u0000", "\u200b", "\u200d", "\u202e", "\u2066", "\ufeff", "\u2028", "\u2029"]) {
      expect(messageSummaryRefusal(`a${character}b`), JSON.stringify(character)).toMatch(/one line of plain text/);
      expect(isMessageInvisibleCharacter(character)).toBe(true);
    }
    expect(isMessageInvisibleCharacter(" ")).toBe(false);
    for (const character of ["<", ">", "`", "&"]) expect(isMessageMarkupCharacter(character)).toBe(true);
    expect(messageSummaryRefusal("see gardener-operation:op_1")).toMatch(/reserved idempotency marker/);
  });

  it("trims before checking, and the schemas apply the same rule", () => {
    expect(messageSendPayloadV1Schema.parse(payload({ summary: "  Crash.  " })).summary).toBe("Crash.");
    expect(messageSendPayloadV1Schema.safeParse(payload({ summary: "   " })).success).toBe(false);
    expect(messageV1Schema.safeParse({ ...message(), summary: "a <b>" }).success).toBe(false);
  });
});

describe("message.send proposals", () => {
  it("accept the message payload and refuse anything else", () => {
    expect(taskEffectProposalV1Schema.safeParse(proposal()).success).toBe(true);
    for (const kind of ["pull_request", "discussion"]) {
      expect(taskEffectProposalV1Schema.safeParse(proposal({ payload: payload({ subject: { kind, number: 3, expectedUpdatedAt: now } }) })).success).toBe(true);
    }
    const refused = (overrides: Record<string, unknown>) => {
      const result = taskEffectProposalV1Schema.safeParse(proposal(overrides));
      return result.success ? [] : result.error.issues.map((issue) => issue.message);
    };
    expect(refused({ payload: payload({ summary: "ping <!here>" }) }).join()).toMatch(/\/summary: summary must not contain/);
    expect(refused({ payload: payload({ subject: { kind: "issue", number: 2 } }) }).join()).toMatch(/expectedUpdatedAt/);
    expect(refused({ payload: payload({ subject: { kind: "commit", number: 2, expectedUpdatedAt: now } }) })).not.toEqual([]);
    expect(refused({ payload: payload({ webhook: "https://hooks.slack.com/x" }) })).not.toEqual([]);
    expect(refused({ references: { "/summary": { step: "a", output: "url" } } }).join()).toMatch(/takes no references/);
  });

  it("are not probed as operations", () => {
    expect(taskStepIssues({ stepName: "notify", kind: "message.send", payload: payload(), references: {} }, { earlier: new Map() })).toEqual([]);
  });

  it("states a payload schema that tells the model where expectedUpdatedAt comes from", () => {
    const schema = JSON.parse(messageSendPayloadJsonSchema()) as {
      properties: { subject: { properties: Record<string, { description?: string }>; required: string[] } };
      required: string[];
    };
    expect(schema.required.sort()).toEqual(["subject", "summary"]);
    expect(schema.properties.subject.required.sort()).toEqual(["expectedUpdatedAt", "kind", "number"]);
    expect(schema.properties.subject.properties.expectedUpdatedAt!.description).toMatch(/normalized event.*provider\.api\.read/);
  });

  it("map onto the plan's field names", () => {
    const parse = (subject: Record<string, unknown>) => messageFromSendPayload(messageSendPayloadV1Schema.parse(payload({ subject })));
    expect(parse({ kind: "issue", number: 2, expectedUpdatedAt: now }).subject).toEqual({ kind: "issue", issueNumber: 2, expectedIssueUpdatedAt: now });
    expect(parse({ kind: "pull_request", number: 3, expectedUpdatedAt: now }).subject).toEqual({ kind: "pull_request", pullNumber: 3, expectedPullUpdatedAt: now });
    expect(parse({ kind: "discussion", number: 4, expectedUpdatedAt: now }).subject)
      .toEqual({ kind: "discussion", discussionNumber: 4, expectedDiscussionUpdatedAt: now });
    expect(parse({ kind: "issue", number: 2, expectedUpdatedAt: now }).channel).toBe("default");
  });
});

describe("messages in the plan", () => {
  it("are optional, at most one, and only on the default channel", () => {
    expect(taskEffectPlanV1Schema.safeParse(plan()).success).toBe(true);
    expect(taskEffectPlanV1Schema.parse(plan())).not.toHaveProperty("messages");
    expect(taskEffectPlanV1Schema.safeParse(plan({ messages: [message()] })).success).toBe(true);
    expect(taskEffectPlanV1Schema.safeParse(plan({ messages: [] })).success).toBe(false);
    expect(taskEffectPlanV1Schema.safeParse(plan({ messages: [message(), message()] })).success).toBe(false);
    expect(taskEffectPlanV1Schema.safeParse(plan({ messages: [{ ...message(), channel: "ops" }] })).success).toBe(false);
  });

  it("are confined to the trigger in trigger scope, by kind and number", () => {
    const elsewhere = message({ kind: "issue", issueNumber: 9, expectedIssueUpdatedAt: now });
    const sameNumberDiscussion = message({ kind: "discussion", discussionNumber: 2, expectedDiscussionUpdatedAt: now });
    for (const scope of ["trigger", "repository", undefined]) {
      const scoped = scope === undefined ? {} : { effectScope: scope };
      expect(taskEffectPlanV1Schema.safeParse(plan({ ...scoped, messages: [message()] })).success, String(scope)).toBe(true);
      expect(taskEffectPlanV1Schema.safeParse(plan({ ...scoped, messages: [elsewhere] })).success, String(scope)).toBe(scope !== "trigger");
      expect(taskEffectPlanV1Schema.safeParse(plan({ ...scoped, messages: [sameNumberDiscussion] })).success, String(scope)).toBe(scope !== "trigger");
    }
  });

  it("names the trigger a confined message must be about", () => {
    const issue = { kind: "issue" as const, id: "301", number: 2 };
    const pullRequest = { kind: "pull_request" as const, id: "302", number: 3 };
    expect(messageTriggerScopeRefusal({ kind: "issue", issueNumber: 2, expectedIssueUpdatedAt: now }, issue)).toBeUndefined();
    // A pull request's conversation is an issue in the same sequence.
    expect(messageTriggerScopeRefusal({ kind: "issue", issueNumber: 3, expectedIssueUpdatedAt: now }, pullRequest)).toBeUndefined();
    expect(messageTriggerScopeRefusal({ kind: "pull_request", pullNumber: 3, expectedPullUpdatedAt: now }, pullRequest)).toBeUndefined();
    expect(messageTriggerScopeRefusal({ kind: "issue", issueNumber: 9, expectedIssueUpdatedAt: now }, issue)).toMatch(/only about issue #2/);
    expect(messageTriggerScopeRefusal({ kind: "issue", issueNumber: 2, expectedIssueUpdatedAt: now }, null)).toMatch(/nothing triggered it/);
  });

  it("are not counted by max-effect-operations", () => {
    expect(taskEffectPlanV1Schema.safeParse(plan({ limits: { maxEffectOperations: 1 }, messages: [message()] })).success).toBe(true);
  });
});
