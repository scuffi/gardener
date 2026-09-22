import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative as relativePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const assets = join(packageRoot, "assets");

if (process.argv.includes("--clean")) {
  await rm(join(repositoryRoot, "apps/gardener/dist/gardener_actions_v1_runtime"), { recursive: true, force: true });
  await rm(assets, { recursive: true, force: true });
  process.exit(0);
}

await rm(assets, { recursive: true, force: true });
await mkdir(join(assets, "apps/gardener/dist"), { recursive: true });
await mkdir(join(assets, "apps/gardener/migrations-actions"), { recursive: true });
await copyRuntimeClosure(
  join(repositoryRoot, "apps/gardener/dist/gardener_actions_v1_runtime"),
  join(assets, "apps/gardener/dist/gardener_actions_v1_runtime"),
);
const migrationRoot = join(repositoryRoot, "apps/gardener/migrations-actions");
for (const name of (await readdir(migrationRoot)).filter((value) => value.endsWith(".sql")).sort()) {
  await cp(join(migrationRoot, name), join(assets, "apps/gardener/migrations-actions", name));
}

async function copyRuntimeClosure(source, destination) {
  const pending = ["index.js"];
  const copied = new Set();
  while (pending.length > 0) {
    const relative = pending.pop();
    if (!relative || copied.has(relative)) continue;
    copied.add(relative);
    const input = join(source, relative);
    const output = join(destination, relative);
    const content = await readFile(input);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, content);
    if (!relative.endsWith(".js")) continue;
    const text = content.toString("utf8");
    for (const match of text.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["'](\.\/[^"']+)["']/g)) {
      const dependency = relativePath(source, resolve(source, dirname(relative), match[1]));
      if (dependency.startsWith("..")) throw new Error(`Runtime asset escapes its distribution root: ${match[1]}`);
      pending.push(dependency);
    }
  }
}

const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
await writeFile(join(assets, "gardener-distribution.json"), `${JSON.stringify({
  schemaVersion: "gardener.cli-distribution/v1",
  package: packageJson.name,
  version: packageJson.version,
}, null, 2)}\n`);
