/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { d1Database } from "./persistence-test-db";

let ensureDatabase: typeof import("../src/database").ensureDatabase;
let migrationStatements: typeof import("../src/database").migrationStatements;

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

beforeAll(async () => {
  vi.doMock("../migrations/0001_initial.sql", () => ({ default: migration("0001_initial.sql") }));
  vi.doMock("../migrations/0004_agent_native_reset.sql", () => ({ default: migration("0004_agent_native_reset.sql") }));
  vi.doMock("../migrations/0005_agent_runtime_admission.sql?raw", () => ({ default: migration("0005_agent_runtime_admission.sql") }));
  vi.doMock("../migrations/0006_flue_harness_requests.sql?raw", () => ({ default: migration("0006_flue_harness_requests.sql") }));
  vi.doMock("../migrations/0007_team_workspace_foundation.sql?raw", () => ({ default: migration("0007_team_workspace_foundation.sql") }));
  vi.doMock("../migrations/0008_flue_native_runtime.sql?raw", () => ({ default: migration("0008_flue_native_runtime.sql") }));
  vi.doMock("../migrations/0009_starter_agents.sql?raw", () => ({ default: migration("0009_starter_agents.sql") }));
  vi.doMock("../migrations/0010_actions_task_runtime.sql?raw", () => ({ default: migration("0010_actions_task_runtime.sql") }));
  ({ ensureDatabase, migrationStatements } = await import("../src/database"));
});

function v6Database(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration("0001_initial.sql"));
  sqlite.exec("INSERT INTO gardener_schema (singleton, version) VALUES (1, 4)");
  sqlite.exec(migration("0005_agent_runtime_admission.sql"));
  sqlite.exec(migration("0006_flue_harness_requests.sql"));
  return sqlite;
}

const digest = "a".repeat(64);

const resetTables = [
  "harness_submissions", "harness_requests", "run_capability_grants", "effects", "run_interruptions",
  "agent_eval_results", "agent_eval_cases", "workspace_leases", "run_artifacts", "run_steps", "run_tasks",
  "inbox_items", "agent_runs", "event_agent_admissions", "repository_events", "agent_activation_history",
  "agent_enablement_history", "agent_activations", "agent_drafts", "agents",
] as const;

function seedAgent(sqlite: DatabaseSync): void {
  sqlite.prepare("INSERT INTO agents (id, slug, name, enabled, created_by) VALUES (?, ?, ?, 1, ?)").run("agent-old", "old", "Old", "legacy");
  sqlite.prepare(`
    INSERT INTO agent_revisions
      (id, agent_id, revision, source_md, source_hash, parsed_json, parsed_hash,
       compiled_json, compiled_hash, provenance_json, provenance_hash,
       compiler_version, catalog_version, runtime_version, published_by)
    VALUES ('revision-old', 'agent-old', 1, 'pre-v1 model text', ?, '{}', ?, '{}', ?, '{}', ?, '1', '1', '1', 'legacy')
  `).run(digest, digest, digest, digest);
}

function seedCompleteV6Graph(sqlite: DatabaseSync): void {
  seedAgent(sqlite);
  sqlite.exec(`
    INSERT INTO agent_drafts
      (id, agent_id, source_md, source_hash, parsed_json, validation_json, compiler_version,
       catalog_version, runtime_version, status, published_revision_id, created_by, updated_by)
    VALUES ('draft-old', 'agent-old', 'pre-v1 model text', '${digest}', '{}', '{}', '1', '1', '1', 'published', 'revision-old', 'legacy', 'legacy');
    INSERT INTO agent_activations (agent_id, revision_id, activated_by)
    VALUES ('agent-old', 'revision-old', 'legacy');
    INSERT INTO agent_activation_history (id, agent_id, revision_id, action, actor_id)
    VALUES ('activation-history-old', 'agent-old', 'revision-old', 'activate', 'legacy');
    INSERT INTO agent_enablement_history (id, agent_id, enabled, actor_id)
    VALUES ('enablement-history-old', 'agent-old', 1, 'legacy');
    INSERT INTO repository_events
      (id, provider, delivery_id, event_kind, action, repository_id, resource_type, resource_id,
       actor_json, facts_json, envelope_json, envelope_hash, admission_status)
    VALUES ('event-old', 'github', 'delivery-old', 'github.issue', 'opened', 'repo-active', 'issue', '1',
      '{}', '{}', '{}', '${digest}', 'completed');
    INSERT INTO event_agent_admissions
      (id, event_id, agent_id, revision_id, admission_key, status)
    VALUES ('admission-old', 'event-old', 'agent-old', 'revision-old', '${digest}', 'admitted');
    INSERT INTO agent_runs
      (id, kind, repository_event_id, agent_id, agent_revision_id, workflow_instance_id, status,
       run_snapshot_json, run_snapshot_hash, policy_snapshot_json, policy_snapshot_hash,
       capability_snapshot_json, capability_snapshot_hash, harness_id, harness_version,
       budgets_json, usage_json, completed_at)
    VALUES ('run-old', 'live', 'event-old', 'agent-old', 'revision-old', 'workflow-old', 'completed',
      '{}', '${digest}', '{}', '${digest}', '{}', '${digest}', 'flue', '2.0.3', '{}', '{}', CURRENT_TIMESTAMP);
    INSERT INTO run_tasks
      (id, run_id, stable_key, kind, status, input_hash)
    VALUES ('task-old', 'run-old', 'task', 'agent', 'completed', '${digest}');
    INSERT INTO run_steps
      (id, run_id, task_id, stable_key, kind, status, input_json, input_hash)
    VALUES ('step-old', 'run-old', 'task-old', 'step', 'model', 'succeeded', '{}', '${digest}');
    INSERT INTO run_artifacts
      (id, run_id, task_id, step_id, kind, r2_key, content_hash, size_bytes, media_type, retention_until)
    VALUES ('artifact-old', 'run-old', 'task-old', 'step-old', 'model-output', 'artifacts/old', '${digest}', 1, 'application/json', '2099-01-01T00:00:00Z');
    INSERT INTO run_interruptions
      (id, run_id, task_id, step_id, kind, eligible_responders_json, eligible_responders_hash,
       request_payload_json, request_payload_hash, nonce_hash, expires_at)
    VALUES ('interruption-old', 'run-old', 'task-old', 'step-old', 'capability', '[]', '${digest}', '{}', '${digest}', '${"b".repeat(64)}', '2099-01-01T00:00:00Z');
    INSERT INTO effects
      (id, operation_id, run_id, task_id, step_id, interruption_id, effect_kind, operation_json,
       operation_hash, rationale, policy_mode, policy_snapshot_hash, status)
    VALUES ('effect-old', 'operation-old', 'run-old', 'task-old', 'step-old', 'interruption-old',
      'issue.comment.create', '{}', '${digest}', 'legacy', 'approval', '${digest}', 'proposed');
    INSERT INTO run_capability_grants
      (id, run_id, interruption_id, capability_kind, scope_json, scope_hash, granted_by, reason, expires_at)
    VALUES ('grant-old', 'run-old', 'interruption-old', 'github.issue.read', '{}', '${digest}', 'legacy', 'legacy', '2099-01-01T00:00:00Z');
    INSERT INTO inbox_items
      (id, kind, run_id, entity_type, entity_id, title, payload_hash)
    VALUES ('inbox-old', 'interruption', 'run-old', 'interruption', 'interruption-old', 'Legacy', '${digest}');
    INSERT INTO agent_eval_cases
      (id, agent_id, revision_id, name, source_kind, fixture_json, fixture_hash,
       expectations_json, created_by)
    VALUES ('eval-case-old', 'agent-old', 'revision-old', 'Legacy', 'system', '{}', '${digest}', '{}', 'legacy');
    INSERT INTO agent_eval_results
      (id, eval_case_id, run_id, agent_id, revision_id, status, scorer_id, scorer_version,
       score, result_json, result_hash, artifact_id, completed_at)
    VALUES ('eval-result-old', 'eval-case-old', 'run-old', 'agent-old', 'revision-old', 'passed',
      'legacy', '1', 1.0, '{}', '${digest}', 'artifact-old', CURRENT_TIMESTAMP);
    INSERT INTO workspace_leases
      (id, run_id, task_id, workspace_key, backend, state, lease_token_hash, lease_expires_at,
       cleanup_after)
    VALUES ('workspace-old', 'run-old', 'task-old', 'workspace-old', 'filesystem', 'active',
      '${digest}', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z');
    INSERT INTO harness_requests
      (run_id, request_id, harness_id, harness_version, request_json, request_hash)
    VALUES ('run-old', 'request-old', 'flue', '2.0.3', '{}', '${digest}');
    INSERT INTO harness_submissions
      (run_id, request_id, submission_id, harness_id, harness_version, submission_json,
       submission_hash, accepted_at)
    VALUES ('run-old', 'request-old', 'submission-old', 'flue', '2.0.3', '{}', '${digest}', CURRENT_TIMESTAMP);
  `);
}

describe("schema v10 starter Agent cutover", () => {
  it("upgrades v6, resets pre-V1 Agent data, and preserves repositories and global policy", async () => {
    const sqlite = v6Database();
    try {
      sqlite.prepare("INSERT INTO repositories (id, installation_id, owner, name, active) VALUES ('repo-active', 'installation', 'owner', 'active', 1)").run();
      sqlite.prepare("INSERT INTO repositories (id, installation_id, owner, name, active) VALUES ('repo-inactive', 'installation', 'owner', 'inactive', 0)").run();
      sqlite.prepare("UPDATE operation_policies SET mode = 'automatic' WHERE operation_kind = 'issue.comment.create'").run();
      sqlite.prepare("UPDATE instance_capability_policies SET mode = 'disabled', constraints_json = '{\"reason\":\"legacy\"}' WHERE capability_kind = 'github.issue.read'").run();
      seedCompleteV6Graph(sqlite);

      for (const table of resetTables) {
        expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
      }
      // The former order attempted these parent deletes while their dependants
      // still existed, so this fixture would fail the cutover under FK enforcement.
      expect(() => sqlite.exec("DELETE FROM run_artifacts")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("DELETE FROM run_tasks")).toThrow(/FOREIGN KEY/);

      await ensureDatabase(d1Database(sqlite));

      expect(sqlite.prepare("SELECT version FROM gardener_schema WHERE singleton = 1").get()).toEqual({ version: 11 });
      expect(sqlite.prepare("SELECT id FROM repositories ORDER BY id").all()).toEqual([{ id: "repo-active" }, { id: "repo-inactive" }]);
      expect(sqlite.prepare("SELECT mode FROM operation_policies WHERE operation_kind = 'issue.comment.create'").get()).toEqual({ mode: "automatic" });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM agents").get()).toEqual({ count: 3 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM agent_revisions").get()).toEqual({ count: 3 });

      expect(sqlite.prepare("SELECT mode, policy_version FROM repository_operation_policies WHERE repository_id = 'repo-active' AND operation_kind = 'issue.comment.create'").get()).toEqual({ mode: "automatic", policy_version: 1 });
      expect(sqlite.prepare("SELECT mode, constraints_json FROM repository_capability_policies WHERE repository_id = 'repo-active' AND capability_kind = 'github.issue.read'").get()).toEqual({ mode: "disabled", constraints_json: "{\"reason\":\"legacy\"}" });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM repository_operation_policies WHERE repository_id = 'repo-inactive'").get()).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM repository_capability_policies WHERE repository_id = 'repo-inactive'").get()).toEqual({ count: 0 });

      for (const table of resetTables) {
        const starterRows = ["agents", "agent_activations", "agent_activation_history"].includes(table) ? 3 : 0;
        expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: starterRows });
      }
    } finally {
      sqlite.close();
    }
  });

  it("installs settings, narrow indexes, run/audit bindings, and STRICT constraints", async () => {
    const sqlite = v6Database();
    try {
      await ensureDatabase(d1Database(sqlite));
      expect(sqlite.prepare("SELECT key, value FROM settings WHERE key IN ('assignment_epoch', 'policy_version') ORDER BY key").all()).toEqual([
        { key: "assignment_epoch", value: "1" },
        { key: "policy_version", value: "1" },
      ]);
      const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_audit_dedupe_%' ORDER BY name").all();
      expect(indexes).toEqual([
        { name: "idx_audit_dedupe_membership" },
        { name: "idx_audit_dedupe_policy_unconfigured" },
        { name: "idx_audit_dedupe_run_cancellation" },
      ]);
      const runColumns = (sqlite.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>).map((row) => row.name);
      expect(runColumns).toEqual(expect.arrayContaining([
        "assignment_id", "assignment_version", "assignment_config_hash", "repository_id",
        "repository_policy_hash", "repository_policy_version", "runtime_driver",
        "result_json", "result_hash", "cancel_requested_at", "cancel_reason",
        "native_model_id", "native_profile", "native_request_protocol", "terminal_claim_hash",
      ]));
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='flue_dispatch_outbox'").get())
        .toEqual({ name: "flue_dispatch_outbox" });
      const auditColumns = (sqlite.prepare("PRAGMA table_info(audit_records)").all() as Array<{ name: string }>).map((row) => row.name);
      expect(auditColumns).toEqual(expect.arrayContaining(["actor", "actor_user_id", "actor_identity_json"]));
      expect(() => sqlite.prepare("INSERT INTO users (id, display_name) VALUES ('u', 'User')").run()).not.toThrow();
      expect(() => sqlite.prepare("INSERT INTO memberships (id, user_id, role) VALUES ('m', 'u', 'admin')").run()).toThrow();
      expect(() => sqlite.prepare("INSERT INTO external_identities (id, user_id, provider, provider_subject, profile_json) VALUES ('e', 'u', 'github', '1', 'bad')").run()).toThrow();
      expect(() => sqlite.prepare("INSERT INTO dashboard_sessions (token_hash, user_id, csrf_digest, cookie_name, idle_expires_at, absolute_expires_at) VALUES ('short', 'u', ?, '__Host-gardener_session', 1, 2)").run(digest)).toThrow();

      expect(() => sqlite.prepare("UPDATE settings SET value = '1' WHERE key = 'policy_version'").run()).not.toThrow();
      expect(() => sqlite.prepare("UPDATE settings SET value = '2' WHERE key = 'policy_version'").run()).not.toThrow();
      expect(() => sqlite.prepare("UPDATE settings SET value = '1' WHERE key = 'policy_version'").run()).toThrow(/monotonic/);

      sqlite.prepare("INSERT INTO repositories (id, installation_id, owner, name) VALUES ('assignment-repo', 'installation', 'owner', 'assignment')").run();
      sqlite.prepare("INSERT INTO agents (id, slug, name, created_by) VALUES ('assignment-agent', 'assignment-agent', 'Assignment', 'u')").run();
      sqlite.prepare("INSERT INTO agent_repository_assignments (id, agent_id, repository_id, config_hash, created_by_user_id, updated_by_user_id) VALUES ('assignment', 'assignment-agent', 'assignment-repo', ?, 'u', 'u')").run(digest);
      expect(() => sqlite.prepare("UPDATE agent_repository_assignments SET updated_at = updated_at WHERE id = 'assignment'").run()).not.toThrow();
      expect(() => sqlite.prepare("UPDATE agent_repository_assignments SET enabled = 1 WHERE id = 'assignment'").run()).toThrow(/authorization changes/);
      expect(() => sqlite.prepare("UPDATE agent_repository_assignments SET enabled = 1, version = 2, config_hash = ? WHERE id = 'assignment'").run("b".repeat(64))).not.toThrow();
    } finally {
      sqlite.close();
    }
  });

  it("upgrades an existing v7 database additively without deleting product rows", async () => {
    const sqlite = v6Database();
    try {
      sqlite.exec(migration("0007_team_workspace_foundation.sql"));
      sqlite.prepare("INSERT INTO agents(id,slug,name,created_by) VALUES('agent-v7','v7','V7','owner')").run();
      sqlite.exec(`
        INSERT INTO agent_revisions(id,agent_id,revision,source_md,source_hash,parsed_json,parsed_hash,
          compiled_json,compiled_hash,provenance_json,provenance_hash,compiler_version,catalog_version,runtime_version,published_by)
        VALUES('revision-v7','agent-v7',1,'source','${digest}','{}','${digest}','{}','${digest}','{}','${digest}','1','1','1','owner');
        INSERT INTO agent_runs(id,kind,agent_id,agent_revision_id,workflow_instance_id,status,run_snapshot_json,
          run_snapshot_hash,policy_snapshot_json,policy_snapshot_hash,capability_snapshot_json,
          capability_snapshot_hash,harness_id,harness_version,budgets_json)
        VALUES('run-v7','manual','agent-v7','revision-v7','workflow-v7','completed','{}','${digest}','{}','${digest}',
          '{}','${digest}','flue','2.0.2','{}');
      `);
      await ensureDatabase(d1Database(sqlite));
      expect(sqlite.prepare("SELECT version FROM gardener_schema WHERE singleton=1").get()).toEqual({ version: 11 });
      expect(sqlite.prepare("SELECT id FROM agents ORDER BY id").all()).toEqual([
        { id: "agent-v7" },
        { id: "agent_gardener_starter_bug_intake" },
        { id: "agent_gardener_starter_documentation_helper" },
        { id: "agent_gardener_starter_issue_triage" },
      ]);
      expect(sqlite.prepare("SELECT runtime_driver FROM agent_runs WHERE id='run-v7'").get())
        .toEqual({ runtime_driver: "workflow-v1" });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='flue_dispatch_outbox'").get())
        .toEqual({ name: "flue_dispatch_outbox" });
    } finally {
      sqlite.close();
    }
  });

  it("guards destructive statements during direct manual SQL replay after v7", async () => {
    const sqlite = v6Database();
    try {
      await ensureDatabase(d1Database(sqlite));
      sqlite.prepare("INSERT INTO agents (id, slug, name, created_by) VALUES ('agent-v7', 'v7', 'V7', 'user-v7')").run();

      const statements = migrationStatements(migration("0007_team_workspace_foundation.sql"));
      // ALTER COLUMN statements are intentionally one-shot, but every preceding
      // destructive statement is safe when an operator manually replays the SQL.
      expect(() => {
        for (const statement of statements) sqlite.exec(statement);
      }).toThrow(/duplicate column name/);
      expect(sqlite.prepare("SELECT id FROM agents ORDER BY id").all()).toEqual([
        { id: "agent-v7" },
        { id: "agent_gardener_starter_bug_intake" },
        { id: "agent_gardener_starter_documentation_helper" },
        { id: "agent_gardener_starter_issue_triage" },
      ]);
      expect(sqlite.prepare("SELECT version FROM gardener_schema WHERE singleton = 1").get()).toEqual({ version: 11 });
    } finally {
      sqlite.close();
    }
  });

  it.each([4, 5])("takes a complete v%i database through the remaining chain to v11", async (version) => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(migration("0001_initial.sql"));
      sqlite.exec("INSERT INTO gardener_schema (singleton, version) VALUES (1, 4)");
      if (version === 5) sqlite.exec(migration("0005_agent_runtime_admission.sql"));
      await ensureDatabase(d1Database(sqlite));
      expect(sqlite.prepare("SELECT version FROM gardener_schema WHERE singleton = 1").get()).toEqual({ version: 11 });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_repository_assignments'").get()).toEqual({ name: "agent_repository_assignments" });
    } finally {
      sqlite.close();
    }
  });

  it("takes a fresh database through the complete chain to v11", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      await ensureDatabase(d1Database(sqlite));
      expect(sqlite.prepare("SELECT version FROM gardener_schema WHERE singleton = 1").get()).toEqual({ version: 11 });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_repository_assignments'").get()).toEqual({ name: "agent_repository_assignments" });
    } finally {
      sqlite.close();
    }
  });
});
