#!/usr/bin/env node
// The version step of release.yml, run by changesets/action to build the
// Version Packages pull request. It consumes the pending changesets, then
// applies the release-time edits changesets does not know about: the release
// date on the new changelog heading, and the pinned version in the onboarding
// guide. Run it locally to preview a release; `git checkout .` undoes it.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PACKAGE = "packages/cli/package.json";
const CHANGELOG = "packages/cli/CHANGELOG.md";
const ONBOARDING = "docs/onboarding.md";

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

// The guide pins the release as a tag (`v0.1.11`) and as an npm version
// (`@scuffi/gardener@0.1.11`); both must move, and nothing else may. The count
// is exact so that a new mention of an old version fails loudly here instead
// of being rewritten: update EXPECTED when the guide gains or loses a pin.
const EXPECTED = 4;
const onboarding = readFileSync(ONBOARDING, "utf8");
const escaped = previous.replaceAll(".", "\\.");
const pattern = new RegExp(`(\\bv|@scuffi/gardener@)${escaped}\\b`, "g");
const count = onboarding.match(pattern)?.length ?? 0;
if (count !== EXPECTED) {
  throw new Error(`${ONBOARDING} mentions ${previous} ${count} times, expected ${EXPECTED}; check each one, then update EXPECTED`);
}
writeFileSync(ONBOARDING, onboarding.replace(pattern, `$1${next}`));
console.log(`@scuffi/gardener ${previous} -> ${next}; dated the changelog and moved ${count} references in ${ONBOARDING}.`);
