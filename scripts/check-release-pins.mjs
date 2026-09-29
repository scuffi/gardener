// Checks that a release's pins resolve before it ships. The CLI generates
// workflows that call reusable workflows at `DEFAULT_WORKFLOW_REF`'s commit,
// and those pin bridge actions by commit. Each layer must exist at its pinned
// commit and accept exactly the inputs the layer above passes; otherwise every
// repository on the release fails at run time. Builds the CLI to render real
// callers, which also rewrites bridges/github/sync/dist from source. Needs full
// git history (`fetch-depth: 0`).
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parse } = createRequire(new URL("../packages/cli/package.json", import.meta.url))("yaml");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const at = (sha, path) => {
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
const exists = (sha, path) => {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}:${path}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const source = readFileSync("packages/cli/src/project.ts", "utf8");
const pinned = /DEFAULT_WORKFLOW_REF =\s*"([^"]+)"/.exec(source)?.[1];
const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/\.github\/workflows\/gardener-task\.yml@([0-9a-f]{40})$/.exec(pinned ?? "");
if (!match) throw new Error(`DEFAULT_WORKFLOW_REF is not a pinned gardener-task.yml ref: ${pinned}`);
const [, repository, sha] = match;
const reusableRef = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)@([0-9a-f]{40})$/;
const bridgeRef = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(bridges\/github\/[a-z]+)@([0-9a-f]{40})$/;

const problems = [];
try {
  git("merge-base", "--is-ancestor", sha, "HEAD");
} catch {
  problems.push(`DEFAULT_WORKFLOW_REF commit ${sha} is not an ancestor of this release`);
}

/** Every passed input is declared, and every required input without a default is passed. */
function checkInputs(where, passed, declared) {
  for (const name of Object.keys(passed ?? {})) {
    if (!(name in (declared ?? {}))) problems.push(`${where} passes input ${name}, which the pinned target doesn't declare`);
  }
  for (const [name, spec] of Object.entries(declared ?? {})) {
    if (spec?.required === true && spec.default === undefined && !(name in (passed ?? {}))) {
      problems.push(`${where} doesn't pass required input ${name}`);
    }
  }
}

// Layer 1: the callers this CLI generates, including the optional
// `checkout-ref` input, against the reusable workflows they pin.
execFileSync("pnpm", ["--filter", "@scuffi/gardener", "build"], { stdio: "ignore" });
const project = mkdtempSync(join(tmpdir(), "gardener-release-pins-"));
const reusable = new Map();
try {
  const cli = (...args) => execFileSync("node", ["packages/cli/dist/cli.js", ...args, "--repository-root", project], { stdio: "ignore" });
  cli("init", "--demos");
  mkdirSync(join(project, ".gardener/tasks/head-commit"), { recursive: true });
  writeFileSync(join(project, ".gardener/tasks/head-commit/TASK.md"), `---
schema: gardener.task/v1
id: head-commit
name: Head commit
description: Commits onto feature branches, so its workflow checks out the pull request head.
trigger:
  event: github.pull_request.labeled
  labels-all: [fix]
tools: [repository.read_file]
effects:
  - kind: commit.create
    branches: ["feature/**"]
network: { default: deny, allow: [], deny: [] }
limits: { runtime-seconds: 60, max-turns: 3, max-tool-calls: 3, input-tokens: 10000, output-tokens: 2000 }
---
Propose one commit.
`);
  cli("generate");
  const workflows = join(project, ".github/workflows");
  let sawCheckoutRef = false;
  for (const file of readdirSync(workflows)) {
    const workflow = parse(readFileSync(join(workflows, file), "utf8"));
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      const ref = reusableRef.exec(job.uses ?? "");
      if (!ref) continue;
      if (ref[1].toLowerCase() !== repository.toLowerCase() || ref[3] !== sha) problems.push(`${file} job ${id} calls ${job.uses}, not ${repository} at ${sha}`);
      if (!reusable.has(ref[2])) reusable.set(ref[2], at(ref[3], ref[2]));
      const called = reusable.get(ref[2]);
      if (called === null) {
        problems.push(`${ref[2]} is missing at ${ref[3]}, called by generated ${file}`);
        continue;
      }
      const trigger = parse(called)?.on?.workflow_call;
      if (trigger === undefined) problems.push(`${ref[2]} at ${ref[3]} is not a reusable workflow (no workflow_call)`);
      checkInputs(`generated ${file} job ${id}`, job.with, trigger?.inputs);
      if (job.with && "checkout-ref" in job.with) sawCheckoutRef = true;
    }
  }
  if (!sawCheckoutRef) problems.push("the fixture no longer renders checkout-ref; update it");
} finally {
  rmSync(project, { recursive: true, force: true });
}
for (const expected of [".github/workflows/gardener-task.yml", ".github/workflows/gardener-sync.yml", ".github/workflows/gardener-check.yml"]) {
  if (!reusable.has(expected)) problems.push(`no generated workflow calls ${expected}`);
}

// Layer 2: each pinned reusable workflow's bridge steps against the bridge
// actions they pin.
for (const [path, content] of reusable) {
  if (content === null) continue;
  let bridges = 0;
  for (const [id, job] of Object.entries(parse(content)?.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const ref = bridgeRef.exec(step.uses ?? "");
      if (!ref) continue;
      bridges += 1;
      if (ref[1].toLowerCase() !== repository.toLowerCase()) problems.push(`${path} at ${sha} pins ${step.uses}, not ${repository}`);
      const action = at(ref[3], `${ref[2]}/action.yml`);
      if (action === null || !exists(ref[3], `${ref[2]}/dist/index.cjs`)) {
        problems.push(`${ref[2]} is incomplete at ${ref[3]}, pinned by ${path}`);
        continue;
      }
      checkInputs(`${path} job ${id} step ${ref[2]}`, step.with, parse(action)?.inputs);
    }
  }
  if (bridges === 0) problems.push(`${path} at ${sha} pins no Gardener bridge`);
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}
console.log(`Release pins resolve: ${pinned}`);
