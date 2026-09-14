/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { operationKindValues } from "@gardener/contracts";
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
  ({ ensureDatabase, migrationStatements } = await import("../src/database"));
});

describe("Agent-native database initialization", () => {
  it("creates the clean schema without a seeded Agent or Workflow V1/V2 tables", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      await ensureDatabase(d1Database(sqlite));

      expect(sqlite.prepare("SELECT version FROM gardener_schema WHERE singleton = 1").get()).toEqual({ version: 7 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM agents").get()).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'harness_requests'").get()).toEqual({ name: "harness_requests" });
      for (const removed of ["workflows", "workflow_revisions", "events", "proposals"]) {
        expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(removed)).toBeUndefined();
      }
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_records'").get()).toEqual({ name: "audit_records" });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_consent_states'").get()).toEqual({ name: "mcp_consent_states" });
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
      expect(sqlite.prepare("SELECT version FROM gardener_schema WHERE singleton = 1").get()).toEqual({ version: 7 });
      expect(sqlite.prepare("SELECT id FROM agents").all()).toEqual([]);
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

      expect(sqlite.prepare("SELECT version FROM gardener_schema WHERE singleton = 1").get()).toEqual({ version: 7 });
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
      expect(sqlite.prepare("SELECT id FROM agents").all()).toEqual([{ id: "agent-1" }]);
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
