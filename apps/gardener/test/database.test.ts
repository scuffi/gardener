/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  agentProvenanceV1Schema,
  agentSourceV1Schema,
  compiledAgentRevisionV1Schema,
  operationKindValues,
} from "@gardener/contracts";
import { canonicalSha256 } from "@gardener/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { d1Database } from "./persistence-test-db";

let ensureDatabase: typeof import("../src/database").ensureDatabase;
let migrationStatements: typeof import("../src/database").migrationStatements;

beforeAll(async () => {
  vi.doMock("../migrations/0001_initial.sql", () => ({
    default: readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0004_agent_native_reset.sql", () => ({
    default: readFileSync(new URL("../migrations/0004_agent_native_reset.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0005_agent_runtime_admission.sql?raw", () => ({
    default: readFileSync(new URL("../migrations/0005_agent_runtime_admission.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0006_flue_harness_requests.sql?raw", () => ({
    default: readFileSync(new URL("../migrations/0006_flue_harness_requests.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0007_team_workspace_foundation.sql?raw", () => ({
    default: readFileSync(new URL("../migrations/0007_team_workspace_foundation.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0008_flue_native_runtime.sql?raw", () => ({
    default: readFileSync(new URL("../migrations/0008_flue_native_runtime.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0009_starter_agents.sql?raw", () => ({
    default: readFileSync(new URL("../migrations/0009_starter_agents.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0010_actions_task_runtime.sql?raw", () => ({
    default: readFileSync(new URL("../migrations/0010_actions_task_runtime.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0011_actions_task_bundles.sql?raw", () => ({
    default: readFileSync(new URL("../migrations/0011_actions_task_bundles.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0012_actions_task_sources.sql?raw", () => ({
    default: readFileSync(new URL("../migrations/0012_actions_task_sources.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0013_actions_control_audit.sql?raw", () => ({
    default: readFileSync(new URL("../migrations/0013_actions_control_audit.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0014_actions_control_audit_triggers.sql?raw", () => ({
    default: readFileSync(new URL("../migrations/0014_actions_control_audit_triggers.sql", import.meta.url), "utf8"),
  }));
  ({ ensureDatabase, migrationStatements } = await import("../src/database"));
});

describe("Agent-native database initialization", () => {
  it("creates the clean schema with safe unassigned starter Agents and no Workflow V1/V2 tables", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      await ensureDatabase(d1Database(sqlite));

      expect(sqlite.prepare("SELECT version FROM gardener_schema WHERE singleton = 1").get()).toEqual({ version: 14 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM agents").get()).toEqual({ count: 3 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM agent_revisions").get()).toEqual({ count: 3 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM agent_activations").get()).toEqual({ count: 3 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM agent_repository_assignments").get()).toEqual({ count: 0 });
      const starters = sqlite.prepare(`
        SELECT r.source_md, r.source_hash, r.parsed_json, r.parsed_hash,
          r.compiled_json, r.compiled_hash, r.provenance_json, r.provenance_hash,
          a.id agent_id, x.revision_id active_revision_id
        FROM agents a JOIN agent_revisions r ON r.agent_id=a.id
        JOIN agent_activations x ON x.agent_id=a.id
        ORDER BY a.id
      `).all() as Array<Record<string, string>>;
      const starterLabels: string[] = [];
      for (const row of starters) {
        const source = agentSourceV1Schema.parse(JSON.parse(row.source_md!));
        const parsed = JSON.parse(row.parsed_json!);
        const compiled = compiledAgentRevisionV1Schema.parse(JSON.parse(row.compiled_json!));
        const provenance = agentProvenanceV1Schema.parse(JSON.parse(row.provenance_json!));
        expect(row.source_hash).toBe(await canonicalSha256(source));
        expect(row.parsed_hash).toBe(await canonicalSha256(parsed));
        expect(row.compiled_hash).toBe(await canonicalSha256(compiled));
        expect(row.provenance_hash).toBe(await canonicalSha256(provenance));
        expect(row.active_revision_id).toBe(compiled.revisionId);
        expect(compiled.spec.triggers).toEqual(["github.issue.opened"]);
        expect(compiled.spec.requestedCapabilities.effects).toEqual(["issue.comment.create"]);
        starterLabels.push(...compiled.spec.eligibility.labelsAll);
      }
      expect(starterLabels.sort()).toEqual(["bug", "documentation", "gardener-test"]);
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'harness_requests'").get()).toEqual({ name: "harness_requests" });
      for (const removed of ["workflows", "workflow_revisions", "events", "proposals"]) {
        expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(removed)).toBeUndefined();
      }
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_records'").get()).toEqual({ name: "audit_records" });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_consent_states'").get()).toEqual({ name: "mcp_consent_states" });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'actions_repository_enrollments'").get()).toEqual({ name: "actions_repository_enrollments" });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'actions_task_runs'").get()).toEqual({ name: "actions_task_runs" });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'actions_task_audit'").get()).toEqual({ name: "actions_task_audit" });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'actions_task_bundles'").get()).toEqual({ name: "actions_task_bundles" });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'actions_repository_tasks'").get()).toEqual({ name: "actions_repository_tasks" });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'actions_control_audit'").get()).toEqual({ name: "actions_control_audit" });
      sqlite.prepare("INSERT INTO actions_repository_enrollments(repository_id,owner_id,owner_login,repository_name,visibility,plan_job_workflow_ref,oidc_audience) VALUES (?,?,?,?,?,?,?)")
        .run("1", "2", "owner", "repository", "private", `owner/actions/.github/workflows/gardener.yml@${"a".repeat(40)}`, "https://runner.example");
      sqlite.prepare("UPDATE actions_repository_enrollments SET enabled=0 WHERE repository_id='1'").run();
      expect(sqlite.prepare("SELECT scope,repository_id,enabled,detail_json FROM actions_control_audit").get()).toEqual({
        scope: "repository",
        repository_id: "1",
        enabled: 0,
        detail_json: '{"source":"database-trigger"}',
      });
      expect(sqlite.prepare("SELECT mode FROM operation_policies WHERE operation_kind = 'issue.label.add'").get()).toEqual({ mode: "approval" });
      expect(sqlite.prepare("SELECT mode FROM operation_policies WHERE operation_kind = 'discussion.comment.create'").get()).toEqual({ mode: "disabled" });
      const operationKinds = (sqlite.prepare("SELECT operation_kind FROM operation_policies ORDER BY operation_kind").all() as Array<{ operation_kind: string }>)
        .map((row) => row.operation_kind);
      expect(operationKinds).toEqual([...operationKindValues].sort());
      expect(sqlite.prepare("SELECT mode FROM instance_capability_policies WHERE capability_kind = 'github.repository.metadata.read'").get()).toEqual({ mode: "automatic" });
      expect(sqlite.prepare("SELECT mode FROM instance_capability_policies WHERE capability_kind = 'workspace.exec.container'").get()).toEqual({ mode: "approval" });
      expect(sqlite.prepare("SELECT mode FROM instance_capability_policies WHERE capability_kind = 'workspace.network.connect'").get()).toEqual({ mode: "disabled" });
      expect(sqlite.prepare("SELECT mode FROM instance_capability_policies WHERE capability_kind = 'workspace.dependencies.install'").get()).toEqual({ mode: "disabled" });
    } finally {
      sqlite.close();
    }
  });

  it("upgrades a complete Agent-native v4 schema through the authorized v7 reset", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
      sqlite.exec("INSERT INTO gardener_schema (singleton, version) VALUES (1, 4)");
      sqlite.prepare("INSERT INTO agents (id, slug, name, created_by) VALUES (?, ?, ?, ?)")
        .run("agent-v4", "agent-v4", "Agent v4", "legacy");
      await ensureDatabase(d1Database(sqlite));
      expect(sqlite.prepare("SELECT version FROM gardener_schema WHERE singleton = 1").get()).toEqual({ version: 14 });
      expect(sqlite.prepare("SELECT id FROM agents ORDER BY id").all()).toHaveLength(3);
      const columns = sqlite.prepare("PRAGMA table_info(repository_events)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("admission_status");
    } finally {
      sqlite.close();
    }
  });

  it("upgrades production v5 while applying the authorized pre-V1 run reset", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
      sqlite.exec("INSERT INTO gardener_schema (singleton, version) VALUES (1, 4)");
      sqlite.exec(readFileSync(new URL("../migrations/0005_agent_runtime_admission.sql", import.meta.url), "utf8"));
      sqlite.exec("PRAGMA foreign_keys = OFF");
      const digest = "a".repeat(64);
      sqlite.prepare(`
        INSERT INTO agent_runs
          (id, kind, agent_id, agent_revision_id, status, run_snapshot_json, run_snapshot_hash,
           policy_snapshot_json, policy_snapshot_hash, capability_snapshot_json, capability_snapshot_hash,
           harness_id, harness_version, budgets_json, usage_json, completed_at)
        VALUES (?, 'manual', ?, ?, 'completed', ?, ?, '{}', ?, '{}', ?, 'cloudflare-agents', '1.0.0', '{}', '{}', ?)
      `).run("historical-run", "historical-agent", "historical-revision", JSON.stringify({ harness: { id: "cloudflare-agents", version: "1.0.0" } }), digest, digest, digest, "2026-09-10T12:00:00.000Z");
      await ensureDatabase(d1Database(sqlite));

      expect(sqlite.prepare("SELECT version FROM gardener_schema WHERE singleton = 1").get()).toEqual({ version: 14 });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'harness_requests'").get()).toEqual({ name: "harness_requests" });
      expect(sqlite.prepare("SELECT * FROM agent_runs WHERE id = 'historical-run'").get()).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("is idempotent after Agent data exists", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      await ensureDatabase(d1Database(sqlite));
      sqlite.prepare("INSERT INTO agents (id, slug, name, created_by) VALUES (?, ?, ?, ?)")
        .run("agent-1", "agent-one", "Agent one", "owner-1");

      await ensureDatabase(d1Database(sqlite));
      expect(sqlite.prepare("SELECT id FROM agents ORDER BY id").all()).toEqual([
        { id: "agent-1" },
        { id: "agent_gardener_starter_bug_intake" },
        { id: "agent_gardener_starter_documentation_helper" },
        { id: "agent_gardener_starter_issue_triage" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("keeps trigger bodies intact while splitting D1 statements", () => {
    const statements = migrationStatements(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
    const triggers = statements.filter((statement) => /^CREATE TRIGGER/i.test(statement));
    expect(triggers).toHaveLength(2);
    expect(triggers[0]).toContain("SELECT RAISE(ABORT, 'agent revisions are immutable');");
    expect(statements.some((statement) => statement.startsWith("PRAGMA"))).toBe(false);

    const v7Statements = migrationStatements(readFileSync(new URL("../migrations/0007_team_workspace_foundation.sql", import.meta.url), "utf8"));
    expect(v7Statements.filter((statement) => /^DELETE FROM/i.test(statement))).toHaveLength(20);
    expect(v7Statements.at(-1)).toContain("version = 7");
  });
});
