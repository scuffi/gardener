/**
 * Trusted merge preparation for `repository.merge_base` and `commit.merge_base`.
 *
 * The bridge computes the merge of a pull request's base branch into its
 * checked-out head *before* the session connects, so before any model
 * command runs, and keeps the result in this process's memory. The model's
 * shell is a descendant of the bridge and cannot read or rewrite it. What is
 * recorded is what a merge commit must contain outside the conflicted files:
 * capture compares the working tree against it exactly, so the model can only
 * resolve conflicts, never slip other changes into a merge.
 *
 * Preparation runs before the capture authority snapshot, and touches only
 * the object database and `.git/shallow` (fetches skip `FETCH_HEAD`); never
 * the working tree, the index, configuration or attributes, which the
 * snapshot digests. `.git/shallow` is covered by no digest, which is harmless:
 * every recorded value is computed here, before the session, and later
 * shallow state cannot change it.
 *
 * The provider read token reaches git only through the child's environment
 * (`GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`), never argv, which other processes of
 * the same user can read, and never `.git/config`.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { COMMIT_FILE_LIMIT, isProtectedCapturePath } from "@gardener/contracts";
import { MERGE_BASE_MESSAGES_MAX_BYTES, type RunnerMergeBaseResultV1 } from "@gardener/protocol";
import { readBoundedBody } from "./github-read";

/** `git merge-tree --write-tree` first shipped in 2.38. */
const MINIMUM_GIT = [2, 38] as const;
const GITLINK_MODE = "160000";
const RUNNER_HOME_PREFIX = ".gardener/runner-home/";
const GIT_MAX_OUTPUT = 64 * 1_024 * 1_024;
const DEFAULT_INITIAL_DEPTH = 50;
/** Doubling `--deepen` rounds before falling back to `--unshallow`. */
const DEEPEN_ROUNDS = 4;
const API_TIMEOUT_MS = 15_000;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA1 = /^[a-f0-9]{40}$/;

/**
 * Same isolation as capture: no global or system configuration, no hooks, no
 * fsmonitor, and no attributes or exclude files from outside the repository.
 * Automatic gc and maintenance are off so a fetch writes nothing but what it
 * fetched. `GIT_LITERAL_PATHSPECS` makes every path a path, never a pattern.
 */
const GIT_PINNED_ARGV = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.excludesFile=/dev/null",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "protocol.ext.allow=never",
] as const;

type Spawn = typeof nodeSpawn;

/** One path the merge changes, as `diff-tree` reports it from HEAD to the merged tree. */
export interface MergeDifference {
  status: "added" | "modified" | "deleted";
  /** Mode at HEAD, `000000` when added. */
  fromMode: string;
  /** Mode in the merged tree, `000000` when deleted. */
  mode: string;
  /** Blob in the merged tree, `null` when deleted. */
  blobSha: string | null;
}

/** A path's entry in the base commit. */
export interface MergeBaseEntry {
  mode: string;
  blobSha: string;
}

/** Everything recorded about one merge, before the model ran. */
export interface PreparedMerge {
  pullNumber: number;
  branch: string;
  expectedHeadSha: string;
  baseBranch: string;
  baseSha: string;
  mergeBaseSha: string;
  mergedTreeSha: string;
  /** Sorted and unique. */
  conflictedPaths: readonly string[];
  differences: ReadonlyMap<string, MergeDifference>;
  /**
   * The base commit's entry for every protected path among the differences
   * and the conflicted paths, or `null` where the base commit has none.
   */
  protectedBase: ReadonlyMap<string, MergeBaseEntry | null>;
  /** Git's merge messages, bounded. */
  messages: string;
}

/**
 * Whether this run prepared a merge, carried with its reason when it could
 * not, so the tool can tell the model why rather than only that it failed.
 */
export type MergePreparation =
  | { status: "ready"; merge: PreparedMerge }
  | { status: "unavailable"; reason: string };

export interface PrepareMergeOptions {
  workspace: string;
  /** `owner/name`. */
  repository: string;
  /** Provider read token; may be empty when origin needs none (tests). */
  token: string;
  pullRequest: { number: number; head: { ref: string; sha: string }; base: { ref: string } };
  /** The head the workflow checked out; HEAD must be exactly this. */
  checkoutSha: string;
  fetch?: typeof fetch;
  spawn?: Spawn;
  /** Depth of the first base fetch. Tests lower it to exercise deepening. */
  initialDepth?: number;
}

/**
 * Prepares the merge. Never throws: any failure leaves the run usable, and
 * `repository.merge_base` reports the recorded reason.
 */
export async function prepareMerge(options: PrepareMergeOptions): Promise<MergePreparation> {
  try {
    return { status: "ready", merge: await prepare(options) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Merge preparation failed";
    return { status: "unavailable", reason: redact(`Gardener could not prepare the merge: ${message}`, options.token) };
  }
}

async function prepare(options: PrepareMergeOptions): Promise<PreparedMerge> {
  const git = gitRunner(options.workspace, options.spawn ?? nodeSpawn);
  const version = (await git.text(["version"])).match(/git version (\d+)\.(\d+)/);
  if (!version || Number(version[1]) < MINIMUM_GIT[0] || (Number(version[1]) === MINIMUM_GIT[0] && Number(version[2]) < MINIMUM_GIT[1])) {
    throw new Error(`git ${version ? `${version[1]}.${version[2]}` : "of unknown version"} is older than 2.38, which merging needs (merge-tree --write-tree)`);
  }
  const head = await git.text(["rev-parse", "HEAD"]);
  if (head !== options.checkoutSha) throw new Error(`HEAD is ${head}, not the checked-out pull request head ${options.checkoutSha}`);
  // The pull request's `base.sha` is only as fresh as GitHub's last
  // recomputation of the pull request, so the branch itself is read.
  const baseBranch = options.pullRequest.base.ref;
  const baseSha = await readBranchHead(options, baseBranch);

  const originUrl = await git.text(["config", "--get", "remote.origin.url"]).catch(() => "");
  if (originUrl === "") throw new Error("the checkout has no origin remote to fetch the base branch from");
  const fetchEnvironment = credentialEnvironment(originUrl, options.token);
  // Deepening follows both sides, so the shared history is reached from each.
  const deepen = (args: readonly string[]) => git.run(
    ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", ...args, "origin", head, baseSha],
    { env: fetchEnvironment },
  );

  if ((await git.run(["cat-file", "-e", `${baseSha}^{commit}`], { allowFailure: true })).code !== 0) {
    await git.run(["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", `--depth=${options.initialDepth ?? DEFAULT_INITIAL_DEPTH}`, "origin", baseSha], { env: fetchEnvironment });
  }
  const mergeBaseSha = await findMergeBase(git, head, baseSha, options.initialDepth ?? DEFAULT_INITIAL_DEPTH, deepen);

  const merge = await git.run(["merge-tree", "--write-tree", "-z", "--name-only", "--messages", head, baseSha], { allowFailure: true });
  if (merge.code !== 0 && merge.code !== 1) throw new Error(`git merge-tree failed (${merge.code}): ${merge.stderr}`);
  const { treeSha: mergedTreeSha, conflictedPaths, messages } = parseMergeTree(merge.stdout);
  if ((merge.code === 1) !== (conflictedPaths.length > 0)) throw new Error("git merge-tree reported conflicts inconsistently");

  const differences = parseDiffTree((await git.run(["diff-tree", "-r", "-z", "--no-renames", head, mergedTreeSha])).stdout);
  if (differences.size > COMMIT_FILE_LIMIT) {
    throw new Error(`the merge changes ${differences.size} files, more than one commit can carry (${COMMIT_FILE_LIMIT}); a person must merge`);
  }
  const protectedPaths = [...new Set([...differences.keys(), ...conflictedPaths])].filter(isProtectedCapturePath);
  const protectedBase = new Map<string, MergeBaseEntry | null>();
  if (protectedPaths.length > 0) {
    const entries = parseLsTree((await git.run(["ls-tree", "-r", "-z", "--full-tree", baseSha])).stdout);
    for (const entry of protectedPaths) protectedBase.set(entry, entries.get(entry) ?? null);
  }
  return {
    pullNumber: options.pullRequest.number,
    branch: options.pullRequest.head.ref,
    expectedHeadSha: head,
    baseBranch,
    baseSha,
    mergeBaseSha,
    mergedTreeSha,
    conflictedPaths,
    differences,
    protectedBase,
    messages: truncateUtf8(messages, MERGE_BASE_MESSAGES_MAX_BYTES),
  };
}

/**
 * Deepens the shallow checkout until HEAD and the base share a merge base
 * that is real history, not a shallow boundary: a boundary commit looks like
 * a root, so a merge base found there would be wrong.
 */
async function findMergeBase(
  git: GitRunner,
  head: string,
  baseSha: string,
  initialDepth: number,
  deepen: (args: readonly string[]) => Promise<unknown>,
): Promise<string> {
  const shallowFile = path.resolve(git.workspace, await git.text(["rev-parse", "--git-path", "shallow"]));
  for (let round = 0; ; round += 1) {
    const found = await git.run(["merge-base", head, baseSha], { allowFailure: true });
    if (found.code !== 0 && found.code !== 1) throw new Error(`git merge-base failed (${found.code}): ${found.stderr}`);
    const shallow = await readShallow(shallowFile);
    const candidate = found.code === 0 ? found.stdout.toString("utf8").trim() : "";
    if (candidate !== "" && !shallow.has(candidate)) return normalizeSha(candidate, "merge base");
    if (shallow.size === 0) throw new Error(`the pull request head and ${baseSha} share no history`);
    if (round < DEEPEN_ROUNDS) await deepen([`--deepen=${initialDepth * 2 ** (round + 1)}`]);
    else if (round === DEEPEN_ROUNDS) await deepen(["--unshallow"]);
    else throw new Error(`no merge base of the pull request head and ${baseSha} was found in the full history`);
  }
}

async function readShallow(file: string): Promise<Set<string>> {
  const text = await readFile(file, "utf8").catch(() => "");
  return new Set(text.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
}

/** Reads `refs/heads/<branch>` from GitHub with the provider read token. */
async function readBranchHead(options: PrepareMergeOptions, branch: string): Promise<string> {
  if (!REPOSITORY.test(options.repository) || options.repository.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("GITHUB_REPOSITORY is not an owner/name slug");
  }
  const ref = branch.split("/").map((segment) => {
    if (segment === "" || segment === "." || segment === "..") throw new Error(`the base branch ${branch} is not a valid branch name`);
    return encodeURIComponent(segment);
  }).join("/");
  const response = await (options.fetch ?? fetch)(`https://api.github.com/repos/${options.repository}/git/ref/heads/${ref}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      "user-agent": "gardener-runner",
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`reading the base branch ${branch} failed (${response.status})`);
  const body = await readBoundedBody(response, 64 * 1_024);
  if (body.truncated) throw new Error(`the base branch ${branch} response is too large`);
  const value = JSON.parse(body.text) as { ref?: unknown; object?: { sha?: unknown } };
  // GitHub answers a missing ref with every ref it prefixes, as a list.
  if (value.ref !== `refs/heads/${branch}` || typeof value.object?.sha !== "string") throw new Error(`the base branch ${branch} was not found`);
  return normalizeSha(value.object.sha, "base branch head");
}

/**
 * The token as an `http.<url>.extraheader` scoped the way `actions/checkout`
 * scopes it (to the server, for http origins), in the child's environment
 * only. Nothing here is written to a file or placed in argv.
 */
function credentialEnvironment(originUrl: string, token: string): NodeJS.ProcessEnv {
  if (!token) return { GIT_CONFIG_COUNT: "0" };
  let scope = originUrl;
  try {
    const url = new URL(originUrl);
    if (url.protocol === "https:" || url.protocol === "http:") scope = `${url.origin}/`;
  } catch {
    // Not a URL git config can scope by origin; scope to the exact remote.
  }
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${scope}.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`,
  };
}

/** `<tree>NUL<conflicted path>NUL...NUL NUL` then message records `<n>NUL<path>xn NUL<type>NUL<message>NUL`. */
function parseMergeTree(output: Buffer): { treeSha: string; conflictedPaths: string[]; messages: string } {
  const fields = output.toString("utf8").split("\u0000");
  const treeSha = normalizeSha(fields[0] ?? "", "merged tree");
  let index = 1;
  const conflicted = new Set<string>();
  for (; index < fields.length && fields[index] !== ""; index += 1) conflicted.add(fields[index]!);
  index += 1;
  const messages: string[] = [];
  while (index < fields.length && fields[index] !== "") {
    const count = Number(fields[index]);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("git merge-tree messages are unreadable");
    index += 1 + count + 1;
    const message = fields[index];
    if (message === undefined) throw new Error("git merge-tree messages are unreadable");
    messages.push(message.endsWith("\n") ? message : `${message}\n`);
    index += 1;
  }
  // Default string order, the order the contract's `sortedUnique` checks.
  return { treeSha, conflictedPaths: [...conflicted].sort(), messages: messages.join("") };
}

/** Raw `diff-tree -z` records: `:<from> <to> <fromSha> <toSha> <status>NUL<path>NUL`. */
function parseDiffTree(output: Buffer): Map<string, MergeDifference> {
  const fields = output.toString("utf8").split("\u0000");
  const differences = new Map<string, MergeDifference>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index]!;
    const entry = fields[index + 1]!;
    if (header === "" && entry === "") break;
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMDT])$/.exec(header);
    if (!match || entry === "") throw new Error("git diff-tree output is unreadable");
    const [, fromMode, mode, , blobSha, status] = match as unknown as [string, string, string, string, string, string];
    differences.set(entry, {
      status: status === "A" ? "added" : status === "D" ? "deleted" : "modified",
      fromMode,
      mode,
      blobSha: status === "D" ? null : blobSha,
    });
  }
  return differences;
}

/** `ls-tree -r -z` records: `<mode> <type> <sha>TAB<path>NUL`. */
function parseLsTree(output: Buffer): Map<string, MergeBaseEntry> {
  const entries = new Map<string, MergeBaseEntry>();
  for (const record of output.toString("utf8").split("\u0000")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, , sha] = record.slice(0, tab).split(" ");
    if (tab < 0 || mode === undefined || sha === undefined) throw new Error("git ls-tree output is unreadable");
    entries.set(record.slice(tab + 1), { mode, blobSha: normalizeSha(sha, "base blob") });
  }
  return entries;
}

/** The tool's success result for a merge. */
export function mergeBaseResult(merge: PreparedMerge): RunnerMergeBaseResultV1 {
  return {
    schemaVersion: "gardener.runner.merge-base-result/v1",
    status: merge.conflictedPaths.length === 0 ? "clean" : "conflicted",
    pullNumber: merge.pullNumber,
    branch: merge.branch,
    expectedHeadSha: merge.expectedHeadSha,
    baseBranch: merge.baseBranch,
    baseSha: merge.baseSha,
    mergeBaseSha: merge.mergeBaseSha,
    conflictedFiles: [...merge.conflictedPaths],
    changedFileCount: merge.differences.size,
    messages: merge.messages,
  };
}

/** A tool refusal: the run continues, and the model is told why. */
export class MergeRefusal extends Error {}

/**
 * Writes the recorded merge into the working tree, and only the working
 * tree: the index keeps naming the pull request head, so capture sees the
 * merge's changes as ordinary modifications and its index digest still holds.
 * Conflicted files carry git's markers.
 *
 * The caller must have verified capture's authority snapshot (configuration,
 * attributes, index) first: the restore below runs the repository's filters.
 */
export async function applyPreparedMerge(workspace: string, merge: PreparedMerge, spawn: Spawn = nodeSpawn): Promise<void> {
  const unsupported = [...merge.differences].filter(([entry, difference]) => {
    const name = entry.split("/").at(-1)!.toLowerCase();
    return name === ".gitattributes" || name === ".gitmodules" || difference.mode === GITLINK_MODE || difference.fromMode === GITLINK_MODE;
  }).map(([entry]) => entry);
  if (unsupported.length > 0) {
    throw new MergeRefusal(
      `This merge changes ${unsupported.slice(0, 5).join(", ")}${unsupported.length > 5 ? " and more" : ""}: `
        + ".gitattributes, .gitmodules and submodules cannot be carried by a Gardener capture, so a person must merge this pull request.",
    );
  }
  const git = gitRunner(workspace, spawn);
  const head = await git.text(["rev-parse", "HEAD"]);
  if (head !== merge.expectedHeadSha) throw new MergeRefusal(`HEAD moved to ${head}; the merge was prepared on ${merge.expectedHeadSha}`);
  const status = (await git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])).stdout
    .toString("utf8").split("\u0000").filter((record) => record !== "" && !record.slice(3).startsWith(RUNNER_HOME_PREFIX));
  if (status.length > 0) {
    throw new MergeRefusal(
      `The working tree already differs from ${head} (${status.slice(0, 5).map((record) => record.slice(3)).join(", ")}${status.length > 5 ? ", ..." : ""}). `
        + "Call repository.merge_base before changing any file: merge first, then resolve.",
    );
  }
  if (merge.differences.size === 0) return;
  const index = (await git.run(["ls-files", "-s", "-z"])).stdout;
  // --no-overlay removes the paths the merged tree no longer has.
  await git.run(
    ["restore", `--source=${merge.mergedTreeSha}`, "--worktree", "--no-overlay", "--pathspec-from-file=-", "--pathspec-file-nul"],
    { input: `${[...merge.differences.keys()].join("\u0000")}\u0000` },
  );
  if (!(await git.run(["ls-files", "-s", "-z"])).stdout.equals(index)) {
    throw new Error("Writing the merge changed the Git index; refusing to continue");
  }
}

/* -------------------------------------------------------------------------- */

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

interface GitRunner {
  workspace: string;
  run(args: readonly string[], options?: { env?: NodeJS.ProcessEnv; input?: string; allowFailure?: boolean }): Promise<GitResult>;
  text(args: readonly string[]): Promise<string>;
}

function gitRunner(workspace: string, spawn: Spawn): GitRunner {
  const run: GitRunner["run"] = (args, options = {}) => new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", workspace, ...GIT_PINNED_ARGV, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "0",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_LITERAL_PATHSPECS: "1",
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const stderr: Buffer[] = [];
    let failure: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > GIT_MAX_OUTPUT) {
        failure ??= new Error(`git ${args[0] ?? ""} produced more than ${GIT_MAX_OUTPUT} bytes`);
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((total, part) => total + part.byteLength, 0) < 4_096) stderr.push(chunk);
    });
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code, signal) => {
      if (failure !== undefined) return reject(failure);
      const result = { code: code ?? 128, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8").trim().split("\n")[0] ?? "" };
      if (result.code !== 0 && options.allowFailure !== true) {
        return reject(new Error(`git ${args[0] ?? ""} failed (${code ?? signal}): ${result.stderr}`.trim()));
      }
      resolve(result);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
  return {
    workspace,
    run,
    text: async (args) => (await run(args)).stdout.toString("utf8").trim(),
  };
}

function normalizeSha(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA1.test(normalized)) throw new Error(`git reported an invalid ${label}`);
  return normalized;
}

function redact(message: string, token: string): string {
  return (token ? message.split(token).join("***") : message).slice(0, 2_000);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
