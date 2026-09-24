/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, canonicalSha256 } from "@gardener/core";
import { describe, expect, it } from "vitest";
import { inspectRepositoryFixtureBundle } from "./fixture-bundle";
import { loadEnabledTaskBundle } from "../src/task-runtime/task-bundles";
import { d1Database } from "./sqlite";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE actions_task_bundles (
      bundle_hash TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      bundle_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE actions_repository_tasks (
      repository_id TEXT NOT NULL,
      bundle_hash TEXT NOT NULL,
      task_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      PRIMARY KEY(repository_id,bundle_hash)
    ) STRICT;
  `);
  return { sqlite, db: d1Database(sqlite) };
}

async function seed(sqlite: DatabaseSync, repositoryId = "100", enabled = 1) {
  const bundle = structuredClone(inspectRepositoryFixtureBundle());
  const bundleHash = await canonicalSha256(bundle);
  sqlite.prepare("INSERT INTO actions_task_bundles(bundle_hash,task_id,bundle_json)VALUES(?,?,?)")
    .run(bundleHash, bundle.taskId, canonicalJson(bundle));
  const sourcePath = ".gardener/tasks/fixture.issue-triage/TASK.md";
  sqlite.prepare("INSERT INTO actions_repository_tasks(repository_id,bundle_hash,task_id,source_path,enabled)VALUES(?,?,?,?,?)")
    .run(repositoryId, bundleHash, bundle.taskId, sourcePath, enabled);
  return { bundle, bundleHash, sourcePath };
}

describe("repository task bundle authority", () => {
  it("loads only the canonical bundle enabled for the authenticated repository", async () => {
    const { sqlite, db } = database();
    try {
      const expected = await seed(sqlite);
      await expect(loadEnabledTaskBundle(db, "100", expected.bundleHash)).resolves.toEqual(expected);
      await expect(loadEnabledTaskBundle(db, "200", expected.bundleHash)).rejects.toThrow(/not enabled/);
      await expect(loadEnabledTaskBundle(db, "100", "f".repeat(64))).rejects.toThrow(/not enabled/);
    } finally { sqlite.close(); }
  });

  it("rejects disabled, altered, and identity-inconsistent bundles", async () => {
    const disabled = database();
    try {
      const expected = await seed(disabled.sqlite, "100", 0);
      await expect(loadEnabledTaskBundle(disabled.db, "100", expected.bundleHash)).rejects.toThrow(/not enabled/);
    } finally { disabled.sqlite.close(); }

    const altered = database();
    try {
      const expected = await seed(altered.sqlite);
      const changed = { ...expected.bundle, name: "Changed after hashing" };
      altered.sqlite.prepare("UPDATE actions_task_bundles SET bundle_json=? WHERE bundle_hash=?")
        .run(canonicalJson(changed), expected.bundleHash);
      await expect(loadEnabledTaskBundle(altered.db, "100", expected.bundleHash)).rejects.toThrow(/canonical bundle bytes/);
    } finally { altered.sqlite.close(); }

    const inconsistent = database();
    try {
      const expected = await seed(inconsistent.sqlite);
      inconsistent.sqlite.prepare("UPDATE actions_task_bundles SET task_id='different-task' WHERE bundle_hash=?")
        .run(expected.bundleHash);
      await expect(loadEnabledTaskBundle(inconsistent.db, "100", expected.bundleHash)).rejects.toThrow(/identity is inconsistent/);
    } finally { inconsistent.sqlite.close(); }
  });
});
