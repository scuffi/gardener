/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, compileWorkflowV2 } from "@gardener/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { d1Database } from "./sqlite";

const initialSchema = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
const workflowRevisionSchema = readFileSync(new URL("../migrations/0003_workflow_revisions.sql", import.meta.url), "utf8");
let processRun: typeof import("../src/index").processRun;
const executeThroughConnect = vi.fn();

beforeAll(async () => {
  vi.doMock("../migrations/0001_initial.sql", () => ({ default: initialSchema }));
  vi.doMock("../migrations/0002_maintainer_policies.sql", () => ({ default: readFileSync(new URL("../migrations/0002_maintainer_policies.sql", import.meta.url), "utf8") }));
  vi.doMock("../migrations/0003_workflow_revisions.sql", () => ({ default: readFileSync(new URL("../migrations/0003_workflow_revisions.sql", import.meta.url), "utf8") }));
  vi.doMock("../src/connect", () => ({
    beginGitHubInstallation: vi.fn(),
    beginGitHubLogin: vi.fn(),
    claimGardenerInstance: vi.fn(),
    executeThroughConnect,
    listConnectedRepositories: vi.fn(),
  }));
  ({ processRun } = await import("../src/index"));
});

function spec(instructions: string, propose: Array<"issue.label.add" | "issue.comment.create">) {
  return {
    name: "Pinned workflow",
    description: "",
    triggers: [{ kind: "github.issue" as const, actions: ["opened" as const] }],
    repositoryIds: ["123456"],
    condition: null,
    runtime: { kind: "workers-ai.issue-gardener" as const, model: "deployment-default" as const, instructions },
    capabilities: { read: ["issue" as const], propose },
    workspace: { enabled: false, experimental: false, network: "denied" as const, allowedHosts: [] },
    limits: { runtimeSeconds: 300, inputTokens: 32000, outputTokens: 8000, costUsd: 1, retries: 2, operations: 4 },
  };
}

describe("pinned v2 issue execution", () => {
  it("loads the run revision after newer activation and applies the immutable proposal ceiling", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(initialSchema);
      sqlite.exec("ALTER TABLE workflows ADD COLUMN active_revision INTEGER; ALTER TABLE workflows ADD COLUMN revision_counter INTEGER NOT NULL DEFAULT 0;");
      sqlite.exec(workflowRevisionSchema);
      sqlite.prepare("UPDATE settings SET value='false' WHERE key='global_paused'").run();
      sqlite.prepare("UPDATE operation_policies SET mode='automatic' WHERE operation_kind='issue.label.add'").run();
      const DB = d1Database(sqlite);
      const old = await compileWorkflowV2(spec("Pinned {{resource.type}} {{resource.id}} #{{resource.number}} in {{repository.full_name}} after {{event.action}}.", ["issue.label.add"]), {
        workflowId: "pinned-workflow", revision: 1, resolvedModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", now: () => new Date("2026-09-03T10:00:00.000Z"),
      });
      const current = await compileWorkflowV2(spec("Keep {{resource.id}} literal.", ["issue.label.add", "issue.comment.create"]), {
        workflowId: "pinned-workflow", revision: 2, resolvedModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", now: () => new Date("2026-09-03T11:00:00.000Z"),
      });
      const preTemplatePlan = structuredClone(current.plan);
      delete preTemplatePlan.runtime.promptTemplateVersion;
      sqlite.prepare(
        "INSERT INTO repositories (id, installation_id, owner, name, active) VALUES ('123456','99','acme','widgets',1)",
      ).run();
      sqlite.prepare(
        "INSERT INTO workflows (id,name,version,enabled,trigger_kind,instructions,compiled_plan,active_revision,revision_counter) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run("pinned-workflow", "Pinned workflow", 2, 1, "github.issue", "Newer mutable projection.", canonicalJson(preTemplatePlan), 2, 2);
      const insertRevision = sqlite.prepare(
        "INSERT INTO workflow_revisions (workflow_id,revision,definition_json,compiled_plan_json,content_hash,validator_version,validation_json,source_kind,created_by,source_metadata_json) VALUES (?,?,?,?,?,'test-v1','{}','dashboard','github:42','{}')",
      );
      insertRevision.run("pinned-workflow", 1, canonicalJson(old.definition), canonicalJson(old.plan), old.definition.contentHash);
      insertRevision.run("pinned-workflow", 2, canonicalJson(current.definition), canonicalJson(preTemplatePlan), current.definition.contentHash);

      const event = {
        schemaVersion: "v1",
        id: "event-pinned",
        deliveryId: "delivery-pinned",
        instanceId: "instance-1",
        kind: "github.issue",
        action: "opened",
        occurredAt: "2026-09-03T12:00:00.000Z",
        repository: { provider: "github", id: "123456", installationId: "99", owner: "acme", name: "widgets" },
        issue: { id: "777", number: 7, title: "Crash on startup", body: "The app fails.", state: "open", labels: [], author: "octocat", htmlUrl: "https://github.com/acme/widgets/issues/7" },
      };
      sqlite.prepare("INSERT INTO events (id,delivery_id,event_kind,action,repository_id,resource_id,envelope) VALUES (?,?,?,?,?,?,?)")
        .run(event.id, event.deliveryId, event.kind, event.action, "123456", event.issue.id, JSON.stringify(event));
      sqlite.prepare("INSERT INTO runs (id,event_id,workflow_id,workflow_version,status,policy_snapshot) VALUES ('run-pinned',?,?,1,'queued',?)")
        .run(event.id, "pinned-workflow", JSON.stringify({ "issue.label.add": "automatic", "issue.comment.create": "automatic" }));
      sqlite.prepare("INSERT INTO run_workflow_plans (run_id,workflow_id,revision,plan_id,content_hash) VALUES ('run-pinned','pinned-workflow',1,?,?)")
        .run(old.plan.planId, old.plan.contentHash);

      const calls: Array<{ model: string; input: any }> = [];
      const env = {
        DB,
        AI_MODEL: "mutable-deployment-model",
        AI: {
          run: async (model: string, input: unknown) => {
            calls.push({ model, input });
            return {
              response: JSON.stringify({
                summary: "A crash report.",
                labels: ["bug"],
                comment: "Please provide the runtime version.",
                rationale: "The issue reports a crash.",
              }),
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
          },
        },
      } as unknown as Env;

      await processRun(env, "run-pinned");

      expect(calls).toHaveLength(1);
      expect(calls[0]?.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
      expect(calls[0]?.input.messages[0].content).toContain("Pinned issue 777 #7 in acme/widgets after opened.");
      expect(calls[0]?.input.messages[0].content).not.toContain("{{resource.id}}");
      expect(calls[0]?.input.messages[0].content).not.toContain("Keep {{resource.id}} literal.");
      expect(sqlite.prepare("SELECT status, summary FROM runs WHERE id='run-pinned'").get()).toMatchObject({ status: "completed", summary: "A crash report." });
      expect(sqlite.prepare("SELECT operation_kind, policy_mode, status FROM proposals WHERE run_id='run-pinned' ORDER BY operation_id").all()).toEqual([
        { operation_kind: "issue.label.add", policy_mode: "approval", status: "pending" },
        { operation_kind: "issue.comment.create", policy_mode: "disabled", status: "disabled" },
      ]);
      expect(executeThroughConnect).not.toHaveBeenCalled();

      const literalEvent = { ...event, id: "event-literal", deliveryId: "delivery-literal", issue: { ...event.issue, id: "779", number: 9 } };
      sqlite.prepare("INSERT INTO events (id,delivery_id,event_kind,action,repository_id,resource_id,envelope) VALUES (?,?,?,?,?,?,?)")
        .run(literalEvent.id, literalEvent.deliveryId, literalEvent.kind, literalEvent.action, "123456", literalEvent.issue.id, JSON.stringify(literalEvent));
      sqlite.prepare("INSERT INTO runs (id,event_id,workflow_id,workflow_version,status,policy_snapshot) VALUES ('run-literal',?,?,2,'queued',?)")
        .run(literalEvent.id, "pinned-workflow", JSON.stringify({ "issue.label.add": "automatic", "issue.comment.create": "automatic" }));
      sqlite.prepare("INSERT INTO run_workflow_plans (run_id,workflow_id,revision,plan_id,content_hash) VALUES ('run-literal','pinned-workflow',2,?,?)")
        .run(preTemplatePlan.planId, preTemplatePlan.contentHash);
      await processRun(env, "run-literal");
      expect(sqlite.prepare("SELECT status, error FROM runs WHERE id='run-literal'").get()).toEqual({ status: "completed", error: null });
      expect(calls).toHaveLength(2);
      expect(calls[1]?.input.messages[0].content).toContain("Keep {{resource.id}} literal.");

      const legacyInstructions = (sqlite.prepare("SELECT instructions FROM workflows WHERE id='issue-gardener'").get() as { instructions: string }).instructions;
      const legacyEvent = { ...event, id: "event-legacy", deliveryId: "delivery-legacy", issue: { ...event.issue, id: "778", number: 8 } };
      sqlite.prepare("INSERT INTO events (id,delivery_id,event_kind,action,repository_id,resource_id,envelope) VALUES (?,?,?,?,?,?,?)")
        .run(legacyEvent.id, legacyEvent.deliveryId, legacyEvent.kind, legacyEvent.action, "123456", legacyEvent.issue.id, JSON.stringify(legacyEvent));
      sqlite.prepare("INSERT INTO runs (id,event_id,workflow_id,workflow_version,status,policy_snapshot) VALUES ('run-legacy',?,'issue-gardener',1,'queued',?)")
        .run(legacyEvent.id, JSON.stringify({ "issue.label.add": "approval", "issue.comment.create": "approval" }));
      const backfilled = await compileWorkflowV2(spec("Backfilled replacement instructions.", ["issue.label.add"]), {
        workflowId: "issue-gardener", revision: 1, resolvedModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      });
      insertRevision.run("issue-gardener", 1, canonicalJson(backfilled.definition), canonicalJson(backfilled.plan), backfilled.definition.contentHash);
      sqlite.prepare("UPDATE workflows SET active_revision=1, revision_counter=1 WHERE id='issue-gardener'").run();

      await processRun(env, "run-legacy");
      expect(calls).toHaveLength(3);
      expect(calls[2]?.model).toBe("mutable-deployment-model");
      expect(calls[2]?.input.messages[0].content).toContain(legacyInstructions);
      expect(calls[2]?.input.messages[0].content).not.toContain("Backfilled replacement instructions.");
      expect(sqlite.prepare("SELECT status FROM runs WHERE id='run-legacy'").get()).toEqual({ status: "completed" });
      expect(sqlite.prepare("SELECT * FROM run_workflow_plans WHERE run_id='run-legacy'").get()).toBeUndefined();

      sqlite.prepare("UPDATE proposals SET status='rejected' WHERE run_id='run-pinned' AND operation_kind='issue.label.add'").run();
      sqlite.prepare("UPDATE proposals SET status='executed' WHERE run_id='run-pinned' AND operation_kind='issue.comment.create'").run();
      sqlite.prepare("UPDATE runs SET status='queued', completed_at=NULL WHERE id='run-pinned'").run();
      await processRun(env, "run-pinned");
      expect(calls).toHaveLength(3);
      expect(sqlite.prepare("SELECT operation_kind, status FROM proposals WHERE run_id='run-pinned' ORDER BY operation_kind").all()).toEqual([
        { operation_kind: "issue.comment.create", status: "executed" },
        { operation_kind: "issue.label.add", status: "rejected" },
      ]);

      for (const [index, priorStatus] of ["pending", "rejected", "executed"].entries()) {
        const partialRunId = `legacy-partial-${priorStatus}`;
        const partialEvent = {
          ...event,
          id: `event-partial-${index}`,
          deliveryId: `delivery-partial-${index}`,
          issue: { ...event.issue, id: String(900 + index), number: 20 + index },
        };
        sqlite.prepare("INSERT INTO events (id,delivery_id,event_kind,action,repository_id,resource_id,envelope) VALUES (?,?,?,?,?,?,?)")
          .run(partialEvent.id, partialEvent.deliveryId, partialEvent.kind, partialEvent.action, "123456", partialEvent.issue.id, JSON.stringify(partialEvent));
        sqlite.prepare("INSERT INTO runs (id,event_id,workflow_id,workflow_version,status,policy_snapshot) VALUES (?,?,'issue-gardener',1,'queued',?)")
          .run(partialRunId, partialEvent.id, JSON.stringify({ "issue.label.add": "automatic" }));
        const legacyOperation = {
          schemaVersion: "v1",
          id: `${partialRunId}:operation:0`,
          kind: "issue.label.add",
          repository: partialEvent.repository,
          issueNumber: partialEvent.issue.number,
          expectedIssueState: "open",
          label: "bug",
        };
        sqlite.prepare(
          "INSERT INTO proposals (id,operation_id,run_id,operation_kind,operation,policy_mode,status,rationale) VALUES (?,?,?,?,?,'approval',?,?)",
        ).run(`proposal-${priorStatus}`, legacyOperation.id, partialRunId, legacyOperation.kind, JSON.stringify(legacyOperation), priorStatus, "Legacy partial result");

        await processRun(env, partialRunId);
        expect(sqlite.prepare("SELECT status, error FROM runs WHERE id=?").get(partialRunId)).toEqual({
          status: "failed",
          error: "Run has unfrozen legacy proposals and requires manual review",
        });
        expect(sqlite.prepare("SELECT status FROM proposals WHERE run_id=?").get(partialRunId)).toEqual({ status: priorStatus });
        expect(sqlite.prepare("SELECT * FROM run_agent_results WHERE run_id=?").get(partialRunId)).toBeUndefined();
      }
      expect(calls).toHaveLength(3);
      expect(executeThroughConnect).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });
});
