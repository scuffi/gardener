#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
};
if (args.includes("--help")) {
  console.log("Usage: node scripts/team-workspace-v7-preflight.mjs --output <manifest.json> [--database gardener] [--cwd apps/gardener]");
  process.exit(0);
}

const output = value("--output");
if (!output) throw new Error("--output is required; keep the resulting manifest as cutover evidence");
const database = value("--database", "gardener");
const cwd = resolve(value("--cwd", "apps/gardener"));
const canonicalJson = (input) => {
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  if (input !== null && typeof input === "object") {
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(",")}}`;
  }
  return JSON.stringify(input);
};
const digest = (values) => createHash("sha256").update([...values].sort().join("\n"), "utf8").digest("hex");

function d1(sql) {
  const result = spawnSync("pnpm", ["exec", "wrangler", "d1", "execute", database, "--remote", "--json", "-y", "--command", sql], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`D1 preflight query failed (exit ${result.status ?? "unknown"}); no manifest was written`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error("Wrangler returned non-JSON D1 output; no manifest was written"); }
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  return blocks.flatMap((block) => block?.results ?? block?.result?.[0]?.results ?? []);
}

const settings = d1("SELECT key, value FROM settings WHERE key IN ('global_paused', 'policy_version', 'assignment_epoch') ORDER BY key");
const schema = d1("SELECT version FROM gardener_schema WHERE singleton = 1")[0];
const nonTerminal = Number(d1("SELECT COUNT(*) AS count FROM agent_runs WHERE status NOT IN ('completed', 'completed_with_errors', 'failed', 'cancelled')")[0]?.count ?? -1);
const counts = d1("SELECT 'repositories' AS kind, COUNT(*) AS count FROM repositories UNION ALL SELECT 'agents', COUNT(*) FROM agents UNION ALL SELECT 'agent_runs', COUNT(*) FROM agent_runs UNION ALL SELECT 'workspace_leases', COUNT(*) FROM workspace_leases UNION ALL SELECT 'run_artifacts', COUNT(*) FROM run_artifacts");
const workflowInstanceIds = d1("SELECT workflow_instance_id AS id FROM agent_runs WHERE workflow_instance_id IS NOT NULL ORDER BY workflow_instance_id").map((row) => String(row.id));
const workspaceKeys = d1("SELECT workspace_key AS id FROM workspace_leases ORDER BY workspace_key").map((row) => String(row.id));
const r2ArtifactKeys = d1("SELECT r2_key AS id FROM run_artifacts WHERE status <> 'deleted' ORDER BY r2_key").map((row) => String(row.id));
const paused = settings.find((row) => row.key === "global_paused")?.value;

if (schema?.version !== 6) throw new Error(`Expected schema version 6 before cutover, received ${schema?.version ?? "missing"}; no manifest was written`);
if (paused !== "true") throw new Error("Global pause is not enabled; no manifest was written");
if (nonTerminal !== 0) throw new Error(`Found ${nonTerminal} non-terminal run(s); no manifest was written`);

const manifest = {
  format: "gardener.team-workspace-v7-preflight/v1",
  capturedAt: new Date().toISOString(),
  database,
  schemaVersion: 6,
  globalPaused: true,
  nonTerminalRuns: 0,
  counts: Object.fromEntries(counts.map((row) => [row.kind, Number(row.count)])),
  resources: {
    workflow: { identifiers: workflowInstanceIds, count: workflowInstanceIds.length, sha256: digest(workflowInstanceIds) },
    workspaceDurableObject: { identifiers: workspaceKeys, count: workspaceKeys.length, sha256: digest(workspaceKeys) },
    r2Artifact: { identifiers: r2ArtifactKeys, count: r2ArtifactKeys.length, sha256: digest(r2ArtifactKeys) },
  },
};
const canonical = canonicalJson(manifest);
const envelope = { ...manifest, manifestSha256: createHash("sha256").update(canonical, "utf8").digest("hex") };
const outputPath = resolve(output);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(envelope, null, 2)}\n`);
await chmod(outputPath, 0o600);
const permissions = (await stat(outputPath)).mode & 0o777;
if (permissions !== 0o600) throw new Error(`Manifest permissions are ${permissions.toString(8)}, expected 600`);
console.log(`Preflight passed: schema=v6 paused=true nonTerminalRuns=0`);
console.log(`Captured workflow=${workflowInstanceIds.length} workspaceDO=${workspaceKeys.length} r2=${r2ArtifactKeys.length}`);
console.log(`Manifest: ${resolve(output)}`);
console.log(`Confirmation: DELETE:${envelope.manifestSha256}`);
