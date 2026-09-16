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
  console.log("Usage: node scripts/flue-native-cutover-preflight.mjs --output <manifest.json> [--database gardener] [--cwd apps/gardener]");
  process.exit(0);
}

const output = value("--output");
if (!output) throw new Error("--output is required; retain the manifest as cutover evidence");
const database = value("--database", "gardener");
const cwd = resolve(value("--cwd", "apps/gardener"));

function d1(sql) {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", database, "--remote", "--json", "-y", "--command", sql],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`D1 cutover query failed (exit ${result.status ?? "unknown"}); no manifest was written`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler returned non-JSON D1 output; no manifest was written");
  }
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  return blocks.flatMap((block) => block?.results ?? block?.result?.[0]?.results ?? []);
}

const schemaVersion = Number(d1("SELECT version FROM gardener_schema WHERE singleton=1")[0]?.version ?? -1);
if (![7, 8, 9].includes(schemaVersion)) {
  throw new Error(`Expected schema 7, 8, or 9 at native cutover, received ${schemaVersion}; no manifest was written`);
}
const paused = d1("SELECT value FROM settings WHERE key='global_paused'")[0]?.value;
const activePredicate = "status IN ('admitted','queued','running','waiting')";
const activeWorkflowRuns = schemaVersion >= 8
  ? Number(d1(`SELECT COUNT(*) AS count FROM agent_runs WHERE runtime_driver='workflow-v1' AND ${activePredicate}`)[0]?.count ?? -1)
  : Number(d1(`SELECT COUNT(*) AS count FROM agent_runs WHERE ${activePredicate}`)[0]?.count ?? -1);
const activeNativeRuns = schemaVersion >= 8
  ? Number(d1(`SELECT COUNT(*) AS count FROM agent_runs WHERE runtime_driver='flue-native-v1' AND ${activePredicate}`)[0]?.count ?? -1)
  : 0;

if (paused !== "true") throw new Error("Global pause is not enabled; no manifest was written");
if (activeWorkflowRuns !== 0) {
  throw new Error(`Found ${activeWorkflowRuns} active workflow-v1 run(s); drain them before native cutover`);
}

const manifest = {
  format: "gardener.flue-native-cutover-preflight/v1",
  capturedAt: new Date().toISOString(),
  database,
  schemaVersion,
  globalPaused: true,
  activeWorkflowRuns,
  activeNativeRuns,
};
const canonical = JSON.stringify(manifest, Object.keys(manifest).sort());
const envelope = {
  ...manifest,
  manifestSha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
};
const outputPath = resolve(output);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(envelope, null, 2)}\n`);
await chmod(outputPath, 0o600);
const permissions = (await stat(outputPath)).mode & 0o777;
if (permissions !== 0o600) throw new Error(`Manifest permissions are ${permissions.toString(8)}, expected 600`);
console.log(`Native cutover preflight passed: schema=v${schemaVersion} paused=true activeWorkflowRuns=0`);
console.log(`Manifest: ${outputPath}`);
