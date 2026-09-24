import { execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const directory = resolve(process.argv[2] ?? ".tmp/cli-pack");
const name = (await readdir(directory)).find((entry) => entry.endsWith(".tgz"));
if (!name) throw new Error(`No CLI tarball exists in ${directory}`);
const archive = join(directory, name);
const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
const required = [
  "package/dist/cli.js",
  "package/assets/gardener-distribution.json",
  "package/assets/apps/gardener/dist/gardener_runtime/index.js",
  "package/assets/apps/gardener/migrations/0001_actions_baseline.sql",
];
for (const path of required) {
  if (!files.includes(path)) throw new Error(`CLI tarball is missing ${path}`);
}
const migrations = files.filter((path) => path.includes("/migrations"));
if (migrations.length !== 1 || migrations[0] !== required[3]) {
  throw new Error(`CLI tarball contains an unexpected migration graph: ${migrations.join(", ")}`);
}
for (const fragment of ["github-gateway", "runner-ingress", "0001_initial", "0004_agent_native_reset"]) {
  if (files.some((path) => path.includes(fragment))) throw new Error(`CLI tarball leaked ${fragment}`);
}
const packageJson = JSON.parse(execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }));
if (Object.values(packageJson.dependencies ?? {}).some((value) => String(value).startsWith("workspace:"))) {
  throw new Error("CLI tarball depends on unpublished workspace packages");
}
const runtime = execFileSync("tar", [
  "-xOzf", archive, "package/assets/apps/gardener/dist/gardener_runtime/index.js",
], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
for (const fragment of ["ComputerWorkspace", "GardenerGitHubEntrypoint", "GardenerFlueAgent", "github-gateway/v1"]) {
  if (runtime.includes(fragment)) throw new Error(`CLI runtime leaked ${fragment}`);
}
if ((await stat(archive)).size > 5 * 1024 * 1024) throw new Error("CLI tarball exceeds the 5 MiB V1 ceiling");
console.log(`${archive}: ${files.length} files, ${(await stat(archive)).size} bytes`);
