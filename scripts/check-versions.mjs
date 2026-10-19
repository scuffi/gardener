import { readdir, readFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const manifests = [
  "package.json",
  "apps/gardener/package.json",
];

for (const entry of await readdir(new URL("packages/", root), { withFileTypes: true })) {
  if (entry.isDirectory()) manifests.push(`packages/${entry.name}/package.json`);
}

const configured = new Map();
let failed = false;
for (const relativePath of manifests) {
  const manifest = JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (String(range).startsWith("workspace:")) continue;
      const current = configured.get(name);
      if (current && current.range !== range) {
        failed = true;
        console.error(`MISMATCH ${name} is ${current.range} in ${current.manifests.join(", ")} but ${range} in ${relativePath}`);
        continue;
      }
      configured.set(name, {
        range: String(range),
        manifests: [...(current?.manifests ?? []), relativePath],
      });
    }
  }
}

const rootManifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const [manager, managerSpec] = rootManifest.packageManager.split("@");
// Corepack may append a hash ("11.25.0+sha512.…"); the version is what's pinned.
const managerVersion = managerSpec.split("+")[0];
configured.set(manager, { range: managerVersion, manifests: ["package.json#packageManager"] });

// These packages are deliberately qualification-pinned. A newer release is a review
// signal, not an automatic upgrade, because it can change preview/runtime behavior or
// the repository's supported package-manager baseline.
const qualificationPins = new Map([
  ["@cloudflare/vite-plugin", "qualified Workers build integration"],
  ["vite", "qualified Workers build integration; updated together with @cloudflare/vite-plugin"],
  ["@cloudflare/workers-types", "published daily; updated together with wrangler"],
  ["@flue/runtime", "qualified Flue adapter family"],
  ["@flue/vite", "qualified Flue adapter family"],
  ["@earendil-works/pi-ai", "qualified Flue 2.0.3 provider peer; a new AI Gateway api family would change the model wire-format table in docs/task-authoring.md"],
  ["wrangler", "qualified Cloudflare deployment tool"],
  ["pnpm", "supported repository package-manager baseline"],
  ["valibot", "qualified Flue runtime peer"],
]);

// Ranges and disagreements between packages fail. A newer npm release only
// warns: it is a prompt to upgrade (Dependabot opens the PR), and failing on it
// would stop every other check from running the moment anything is published.
const annotate = process.env.GITHUB_ACTIONS === "true";
// Escaped as workflow-command data, so no text can start a command of its own.
const commandData = (text) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const warn = (line) => {
  console.error(line);
  if (annotate) console.log(`::warning title=Dependency drift::${commandData(line)}`);
};

const exactVersion = (range) => range.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1];
const results = await Promise.all(
  [...configured].sort(([a], [b]) => a.localeCompare(b)).map(async ([name, detail]) => {
    const current = exactVersion(detail.range);
    try {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
        headers: { accept: "application/json", "user-agent": "gardener-version-check/1" },
      });
      if (response.status === 404) return { name, current, missing: true, detail };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Only an exact version is trusted into the output.
      const latest = exactVersion(String((await response.json()).version ?? ""));
      if (!latest) throw new Error("the registry returned no readable version");
      return { name, current, latest, detail };
    } catch (error) {
      return { name, current, latest: undefined, lookupError: error instanceof Error ? error.message : String(error), detail };
    }
  }),
);

for (const { name, current, latest, missing, lookupError, detail } of results) {
  if (!current) {
    failed = true;
    console.error(`INVALID  ${name}@${detail.range} must be pinned to an exact version`);
  } else if (missing) {
    failed = true;
    console.error(`MISSING  ${name} is not on the npm registry (${detail.manifests.join(", ")})`);
  } else if (latest === undefined) {
    warn(`UNKNOWN  ${name}@${current}; the npm registry lookup failed (${lookupError})`);
  } else if (current !== latest && qualificationPins.has(name)) {
    console.log(`PINNED   ${name}@${current}; latest is ${latest} (${qualificationPins.get(name)})`);
  } else if (current !== latest) {
    warn(`OUTDATED ${name}@${current}; latest is ${latest} (${detail.manifests.join(", ")})`);
  } else {
    console.log(`CURRENT  ${name}@${current}`);
  }
}

if (failed) process.exitCode = 1;
