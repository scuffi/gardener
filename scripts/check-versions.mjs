import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = new URL("../", import.meta.url);
const manifests = ["package.json"];

for (const workspace of ["apps", "packages"]) {
  const directory = new URL(`${workspace}/`, root);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) manifests.push(`${workspace}/${entry.name}/package.json`);
  }
}

const configured = new Map();
for (const relativePath of manifests) {
  const manifest = JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (String(range).startsWith("workspace:")) continue;
      const current = configured.get(name);
      if (current && current.range !== range) {
        throw new Error(`${name} has inconsistent versions: ${current.range} and ${range}`);
      }
      configured.set(name, {
        range: String(range),
        manifests: [...(current?.manifests ?? []), relativePath],
      });
    }
  }
}

const rootManifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const [manager, managerVersion] = rootManifest.packageManager.split("@");
configured.set(manager, { range: managerVersion, manifests: ["package.json#packageManager"] });

// These packages are deliberately qualification-pinned. A newer release is a review
// signal, not an automatic upgrade, because it can change preview/runtime behavior or
// the repository's supported package-manager baseline.
const qualificationPins = new Map([
  ["@cloudflare/computer", "preview workspace adapter"],
  ["@cloudflare/think", "preview harness adapter"],
  ["@flue/cli", "qualified Flue adapter family"],
  ["@flue/runtime", "qualified Flue adapter family"],
  ["@flue/vite", "qualified Flue adapter family"],
  ["@cloudflare/workers-oauth-provider", "qualified OAuth boundary"],
  ["@modelcontextprotocol/server", "qualified MCP boundary"],
  ["agents", "qualified Cloudflare Agents adapter"],
  ["pnpm", "supported repository package-manager baseline"],
  ["valibot", "qualified Flue runtime peer"],
]);

const exactVersion = (range) => range.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1];
const results = await Promise.all(
  [...configured].sort(([a], [b]) => a.localeCompare(b)).map(async ([name, detail]) => {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      headers: { accept: "application/json", "user-agent": "gardener-version-check/1" },
    });
    if (!response.ok) throw new Error(`Registry lookup failed for ${name}: HTTP ${response.status}`);
    const latest = (await response.json()).version;
    const current = exactVersion(detail.range);
    return { name, current, latest, detail };
  }),
);

let failed = false;
for (const { name, current, latest, detail } of results) {
  if (!current) {
    failed = true;
    console.error(`INVALID  ${name}@${detail.range} must be pinned to an exact version`);
  } else if (current !== latest && qualificationPins.has(name)) {
    console.log(`PINNED   ${name}@${current}; latest is ${latest} (${qualificationPins.get(name)})`);
  } else if (current !== latest) {
    failed = true;
    console.error(`OUTDATED ${name}@${current}; latest is ${latest} (${detail.manifests.join(", ")})`);
  } else {
    console.log(`CURRENT  ${name}@${current}`);
  }
}

if (failed) process.exitCode = 1;
