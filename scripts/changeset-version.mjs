#!/usr/bin/env node
// The version step of release.yml, run by changesets/action to build the
// Version Packages pull request. It consumes the pending changesets, then
// applies the release-time edits changesets does not know about: the release
// date on the new changelog heading, and the pinned version in the onboarding
// and getting-started guides. Run it locally to preview a release; `git checkout .` undoes it.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PACKAGE = "packages/cli/package.json";
const CHANGELOG = "packages/cli/CHANGELOG.md";
// Each guide's exact number of release pins.
const GUIDES = [
  ["docs/onboarding.md", 5],
  ["docs/getting-started.md", 1],
];

const version = () => JSON.parse(readFileSync(PACKAGE, "utf8")).version;

const previous = version();
execFileSync("pnpm", ["exec", "changeset", "version"], { stdio: "inherit" });
const next = version();
if (next === previous) {
  console.log(`@scuffi/gardener stays at ${previous}; nothing else to update.`);
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const changelog = readFileSync(CHANGELOG, "utf8");
const heading = `## ${next}\n`;
if (!changelog.includes(heading)) throw new Error(`${CHANGELOG} has no "${heading.trim()}" heading`);
writeFileSync(CHANGELOG, changelog.replace(heading, `## ${next} (${today})\n`));

// The guides pin the release as a tag (`v0.1.11`) and as an npm version
// (`@scuffi/gardener@0.1.11`); both must move, and nothing else may. Each count
// is exact so that a new mention of an old version fails loudly here instead
// of being rewritten: update GUIDES when a guide gains or loses a pin. Every
// guide is checked before any is written.
const escaped = previous.replaceAll(".", "\\.");
const pattern = new RegExp(`(\\bv|@scuffi/gardener@)${escaped}\\b`, "g");
const guides = GUIDES.map(([path, expected]) => {
  const text = readFileSync(path, "utf8");
  const count = text.match(pattern)?.length ?? 0;
  if (count !== expected) {
    throw new Error(`${path} mentions ${previous} ${count} times, expected ${expected}; check each one, then update GUIDES`);
  }
  return { path, text, count };
});
for (const { path, text } of guides) writeFileSync(path, text.replace(pattern, `$1${next}`));
console.log(`@scuffi/gardener ${previous} -> ${next}; dated the changelog and moved ${guides.map(({ path, count }) => `${count} references in ${path}`).join(" and ")}.`);
