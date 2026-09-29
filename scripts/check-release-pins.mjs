// Checks that a release's pins resolve before it ships. The CLI generates
// workflows that call `DEFAULT_WORKFLOW_REF`'s commit, and the reusable
// workflows there pin bridge actions by commit. If any of them lacks what is
// referenced, every repository on the release fails with "not found". Needs
// full git history (`fetch-depth: 0`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const has = (sha, path) => {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}:${path}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const source = readFileSync("packages/cli/src/project.ts", "utf8");
const pinned = /DEFAULT_WORKFLOW_REF =\s*"([^"]+)"/.exec(source)?.[1];
const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(\.github\/workflows\/gardener-task\.yml)@([0-9a-f]{40})$/.exec(pinned ?? "");
if (!match) throw new Error(`DEFAULT_WORKFLOW_REF is not a pinned gardener-task.yml ref: ${pinned}`);
const [, repository, , sha] = match;

const problems = [];
try {
  git("merge-base", "--is-ancestor", sha, "HEAD");
} catch {
  problems.push(`DEFAULT_WORKFLOW_REF commit ${sha} is not an ancestor of this release`);
}
for (const workflow of [".github/workflows/gardener-task.yml", ".github/workflows/gardener-sync.yml"]) {
  if (!has(sha, workflow)) {
    problems.push(`${workflow} is missing at the DEFAULT_WORKFLOW_REF commit ${sha}`);
    continue;
  }
  const bridges = [...git("show", `${sha}:${workflow}`).matchAll(/uses: ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(bridges\/github\/[a-z]+)@([0-9a-f]{40})/g)];
  if (bridges.length === 0) problems.push(`${workflow} at ${sha} pins no Gardener bridge`);
  for (const [, owner, bridge, bridgeSha] of bridges) {
    if (owner !== repository) problems.push(`${workflow} at ${sha} pins ${owner}/${bridge}, not ${repository}`);
    for (const file of ["action.yml", "dist/index.cjs"]) {
      if (!has(bridgeSha, `${bridge}/${file}`)) problems.push(`${bridge}/${file} is missing at ${bridgeSha}, pinned by ${workflow}`);
    }
  }
}
if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}
console.log(`Release pins resolve: ${pinned}`);
