/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const baseline = readFileSync(
  new URL("../migrations-actions/0001_actions_baseline.sql", import.meta.url),
  "utf8",
);

describe("Actions-only D1 baseline", () => {
  it("creates only the six Actions runtime tables and atomic control-audit triggers", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(baseline);
      const tables = (sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toEqual([
        "actions_control_audit",
        "actions_repository_enrollments",
        "actions_repository_tasks",
        "actions_task_audit",
        "actions_task_bundles",
        "actions_task_runs",
      ]);
      expect(tables).not.toEqual(expect.arrayContaining(["agents", "repositories", "workflows", "oauth_clients"]));

      sqlite.prepare("INSERT INTO actions_repository_enrollments(repository_id,owner_id,owner_login,repository_name,visibility,plan_job_workflow_ref,oidc_audience) VALUES (?,?,?,?,?,?,?)")
        .run("1", "2", "owner", "repository", "private", `owner/actions/.github/workflows/gardener.yml@${"a".repeat(40)}`, "https://runner.example");
      sqlite.prepare("UPDATE actions_repository_enrollments SET enabled=0 WHERE repository_id='1'").run();
      expect(sqlite.prepare("SELECT scope,repository_id,enabled FROM actions_control_audit").get())
        .toEqual({ scope: "repository", repository_id: "1", enabled: 0 });
    } finally {
      sqlite.close();
    }
  });
});
