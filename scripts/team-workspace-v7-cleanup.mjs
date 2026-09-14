#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
};
if (args.includes("--help")) {
  console.log("Usage: node scripts/team-workspace-v7-cleanup.mjs --manifest <file> [--execute --confirm DELETE:<manifest-sha256>] [--workflow gardener-agent-runs] [--bucket gardener-computer-inputs]");
  process.exit(0);
}
const manifestPath = value("--manifest");
if (!manifestPath) throw new Error("--manifest is required");
const execute = args.includes("--execute");
const confirm = value("--confirm", "");
const cwd = resolve(value("--cwd", "apps/gardener"));
const workflow = value("--workflow", "gardener-agent-runs");
const bucket = value("--bucket", "gardener-computer-inputs");
const canonicalJson = (input) => {
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  if (input !== null && typeof input === "object") {
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(",")}}`;
  }
  return JSON.stringify(input);
};
const envelope = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
if (envelope.format !== "gardener.team-workspace-v7-preflight/v1") throw new Error("Unsupported preflight manifest format");
const { manifestSha256, ...manifest } = envelope;
const actualHash = createHash("sha256").update(canonicalJson(manifest), "utf8").digest("hex");
if (actualHash !== manifestSha256) throw new Error("Manifest integrity check failed");
if (manifest.schemaVersion !== 6 || manifest.globalPaused !== true || manifest.nonTerminalRuns !== 0) throw new Error("Manifest does not prove a paused v6 database with zero non-terminal runs");
for (const resource of Object.values(manifest.resources ?? {})) {
  const identifiers = resource.identifiers ?? [];
  const hash = createHash("sha256").update([...identifiers].sort().join("\n")).digest("hex");
  if (resource.count !== identifiers.length || resource.sha256 !== hash) throw new Error("Manifest resource integrity check failed");
}
const workflows = manifest.resources.workflow.identifiers;
const workspaces = manifest.resources.workspaceDurableObject.identifiers;
const r2Keys = manifest.resources.r2Artifact.identifiers;

console.log(`${execute ? "DESTRUCTIVE" : "DRY RUN"}: workflow=${workflows.length} workspaceDO=${workspaces.length} r2=${r2Keys.length}`);
for (const id of workflows) console.log(`workflow ${id}`);
for (const id of workspaces) console.log(`workspaceDO ${id}`);
for (const id of r2Keys) console.log(`r2 ${id}`);
if (!execute) {
  console.log(`No changes made. Re-run with --execute --confirm DELETE:${manifestSha256}`);
  process.exit(0);
}
if (confirm !== `DELETE:${manifestSha256}`) throw new Error("Destructive confirmation did not exactly match the manifest");

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Wrangler has no supported command for deleting one Durable Object by its
// unique-name key. Fail before making any partial destructive change, and never
// dispatch an operator-provided executable to work around that platform limit.
if (workspaces.length > 0) {
  for (const key of workspaces) console.error(`RETAINED workspaceDO ${key}: no supported verified deletion command`);
  throw new Error(`${workspaces.length} captured workspace/DO key(s) were retained; no cleanup was attempted`);
}

for (const id of workflows) {
  // Preflight admits only terminal runs, so deleting the captured instance is
  // safe; attempting to terminate it first is both unnecessary and unreliable.
  const deleted = run("pnpm", ["exec", "wrangler", "workflows", "instances", "delete", workflow, id]);
  if (!deleted.ok) throw new Error(`Failed to delete Workflow instance ${id}; cleanup stopped`);
  const verification = run("pnpm", ["exec", "wrangler", "workflows", "instances", "describe", workflow, id, "--json"]);
  if (verification.ok) throw new Error(`Workflow instance ${id} still exists after deletion; cleanup stopped`);
  if (!/(404|not[ -]?found|does not exist)/i.test(`${verification.stdout}\n${verification.stderr}`)) {
    throw new Error(`Unable to verify Workflow instance ${id} is absent; cleanup stopped`);
  }
}
const temporary = await mkdtemp(join(tmpdir(), "gardener-v7-r2-verify-"));
try {
  for (const key of r2Keys) {
    if (!run("pnpm", ["exec", "wrangler", "r2", "object", "delete", `${bucket}/${key}`, "--remote"]).ok) throw new Error(`Failed to delete R2 key ${key}; cleanup stopped`);
    const probe = join(temporary, createHash("sha256").update(key).digest("hex"));
    const verification = run("pnpm", ["exec", "wrangler", "r2", "object", "get", `${bucket}/${key}`, "--remote", "--file", probe]);
    if (verification.ok) throw new Error(`R2 key ${key} still exists after deletion; cleanup stopped`);
    if (!/(404|not[ -]?found|does not exist)/i.test(`${verification.stdout}\n${verification.stderr}`)) {
      throw new Error(`Unable to verify R2 key ${key} is absent; cleanup stopped`);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log("Cleanup completed; every captured Workflow and R2 resource was verified absent.");
