import { execFile, spawn as nodeSpawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runnerCaptureResultV1Schema, runnerMergeBaseResultV1Schema, type RunnerActionV1 } from "@gardener/protocol";
import { taskCaptureManifestV1Schema } from "@gardener/contracts";
import { createPlanningExecutor } from "../src/executor";
import { prepareMerge, type MergePreparation, type PreparedMerge } from "../src/merge-base";

/** Every case shells out to real Git many times, which is slow on macOS. */
const GIT_TEST_TIMEOUT = 120_000;
const execFileAsync = promisify(execFile);
const roots: string[] = [];
const TOKEN = "ghs_mergeFixtureToken0123456789";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Files = Record<string, string | null>;

interface Fixture {
  root: string;
  origin: string;
  workspace: string;
  runnerTemp: string;
  mergeBase: string;
  head: string;
  main: string;
}

/**
 * An origin with `main` and `feature` diverged from one base commit, and a
 * depth-1 checkout of `feature`, as `actions/checkout` leaves it.
 */
async function fixture(options: { base: Files; feature: Files; main: Files; history?: number }): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "gardener-merge-base-"));
  roots.push(root);
  const origin = path.join(root, "origin");
  await mkdir(origin);
  await git(origin, ["init", "--quiet", "--initial-branch=main"]);
  await git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  await commit(origin, options.base, "base");
  const mergeBase = await rev(origin, "HEAD");
  await git(origin, ["checkout", "--quiet", "-b", "feature"]);
  for (let index = 0; index < (options.history ?? 0); index += 1) await commit(origin, { [`feature-${index}.txt`]: `${index}\n` }, `feature ${index}`);
  await commit(origin, options.feature, "feature");
  await git(origin, ["checkout", "--quiet", "main"]);
  for (let index = 0; index < (options.history ?? 0); index += 1) await commit(origin, { [`main-${index}.txt`]: `${index}\n` }, `main ${index}`);
  await commit(origin, options.main, "main");
  const workspace = path.join(root, "workspace");
  await git(root, ["clone", "--quiet", "--depth=1", "--branch=feature", `file://${origin}`, workspace]);
  const runnerTemp = path.join(root, "temp");
  await mkdir(runnerTemp);
  return { root, origin, workspace, runnerTemp, mergeBase, head: await rev(origin, "feature"), main: await rev(origin, "main") };
}

async function commit(cwd: string, files: Files, message: string): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(cwd, file);
    if (content === null) {
      await unlink(absolute);
      continue;
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  await git(cwd, ["add", "--all"]);
  await git(cwd, ["commit", "--quiet", "--allow-empty", "--message", message]);
}

async function rev(cwd: string, name: string): Promise<string> {
  return (await git(cwd, ["rev-parse", name])).trim();
}

async function git(cwd: string, argv: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...argv], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Gardener",
      GIT_AUTHOR_EMAIL: "gardener@example.test",
      GIT_COMMITTER_NAME: "Gardener",
      GIT_COMMITTER_EMAIL: "gardener@example.test",
    },
  });
  return stdout;
}

interface SpawnCall { argv: readonly string[]; env: NodeJS.ProcessEnv }

/** Records every git invocation, so a test can prove where the token went. */
function recordingSpawn(calls: SpawnCall[], fake?: (argv: readonly string[]) => string | undefined): typeof nodeSpawn {
  return ((command: string, argv: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ argv: [command, ...argv], env: options.env ?? {} });
    const output = fake?.(argv);
    if (output !== undefined) return nodeSpawn("/bin/echo", [output], options as never);
    return nodeSpawn(command, argv as string[], options as never);
  }) as unknown as typeof nodeSpawn;
}

function baseBranchFetch(main: string, status = 200): typeof fetch {
  return (async () => Response.json(status === 200 ? { ref: "refs/heads/main", object: { sha: main, type: "commit" } } : {}, { status })) as typeof fetch;
}

async function prepare(value: Fixture, options: { calls?: SpawnCall[]; initialDepth?: number; token?: string; fetch?: typeof fetch; fake?: (argv: readonly string[]) => string | undefined } = {}): Promise<MergePreparation> {
  return prepareMerge({
    workspace: value.workspace,
    repository: "acme/widgets",
    token: options.token ?? TOKEN,
    pullRequest: { number: 7, head: { ref: "feature", sha: value.head }, base: { ref: "main" } },
    checkoutSha: value.head,
    fetch: options.fetch ?? baseBranchFetch(value.main),
    spawn: recordingSpawn(options.calls ?? [], options.fake),
    ...(options.initialDepth === undefined ? {} : { initialDepth: options.initialDepth }),
  });
}

function ready(preparation: MergePreparation): PreparedMerge {
  if (preparation.status !== "ready") throw new Error(preparation.reason);
  return preparation.merge;
}

const CONFLICTING = {
  base: { "f.txt": "a\nb\nc\n", "d.txt": "keep\n", "same.txt": "same\n" },
  feature: { "f.txt": "a\nFEATURE\nc\n", "d.txt": "modified\n" },
  main: { "f.txt": "a\nMAIN\nc\n", "d.txt": null, "n.txt": "new\n" },
};

describe("merge preparation", () => {
  it("records a content conflict and a modify/delete conflict against the base branch head", async () => {
    const value = await fixture(CONFLICTING);
    const merge = ready(await prepare(value));
    expect(merge).toMatchObject({
      pullNumber: 7, branch: "feature", expectedHeadSha: value.head, baseBranch: "main", baseSha: value.main, mergeBaseSha: value.mergeBase,
      conflictedPaths: ["d.txt", "f.txt"],
    });
    // d.txt keeps the head's version in git's merged tree, so only f.txt and n.txt differ.
    expect([...merge.differences.keys()].sort()).toEqual(["f.txt", "n.txt"]);
    expect(merge.differences.get("n.txt")).toMatchObject({ status: "added", fromMode: "000000", mode: "100644" });
    expect(merge.differences.get("f.txt")).toMatchObject({ status: "modified", mode: "100644" });
    expect(merge.messages).toContain("CONFLICT (content): Merge conflict in f.txt");
    expect(merge.messages).toContain("CONFLICT (modify/delete)");
    expect(merge.protectedBase.size).toBe(0);
  }, GIT_TEST_TIMEOUT);

  it("records a clean merge", async () => {
    const value = await fixture({ base: { "a.txt": "a\n", "b.txt": "b\n" }, feature: { "a.txt": "A\n" }, main: { "b.txt": "B\n" } });
    const merge = ready(await prepare(value));
    expect(merge.conflictedPaths).toEqual([]);
    expect([...merge.differences]).toEqual([["b.txt", expect.objectContaining({ status: "modified" })]]);
  }, GIT_TEST_TIMEOUT);

  it("deepens a shallow checkout until the merge base is real history, never a shallow boundary", async () => {
    const value = await fixture({ ...CONFLICTING, history: 3 });
    const calls: SpawnCall[] = [];
    const merge = ready(await prepare(value, { calls, initialDepth: 1 }));
    expect(merge.mergeBaseSha).toBe(value.mergeBase);
    const fetches = calls.filter((call) => call.argv.includes("fetch")).map((call) => call.argv.find((arg) => arg.startsWith("--de")));
    expect(fetches[0]).toBe("--depth=1");
    expect(fetches.slice(1).length).toBeGreaterThan(0);
    expect(fetches.slice(1).every((arg) => arg?.startsWith("--deepen="))).toBe(true);
  }, GIT_TEST_TIMEOUT);

  it("passes the token only through the fetch's environment, never argv or configuration", async () => {
    const value = await fixture(CONFLICTING);
    const calls: SpawnCall[] = [];
    const before = {
      config: await readFile(path.join(value.workspace, ".git", "config"), "utf8"),
      index: await git(value.workspace, ["ls-files", "-s"]),
      status: await git(value.workspace, ["status", "--porcelain", "--untracked-files=all"]),
    };
    ready(await prepare(value, { calls, initialDepth: 1 }));
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    for (const call of calls) {
      expect(call.argv.join(" ")).not.toContain(TOKEN);
      expect(call.argv.join(" ")).not.toContain(basic);
    }
    const fetches = calls.filter((call) => call.argv.includes("fetch"));
    expect(fetches.length).toBeGreaterThan(1);
    for (const call of fetches) {
      expect(call.env).toMatchObject({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.file://${value.origin}.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      });
    }
    for (const call of calls.filter((entry) => !entry.argv.includes("fetch"))) expect(call.env.GIT_CONFIG_VALUE_0).toBeUndefined();
    // Nothing the capture baseline digests was touched.
    expect(await readFile(path.join(value.workspace, ".git", "config"), "utf8")).toBe(before.config);
    expect(await git(value.workspace, ["ls-files", "-s"])).toBe(before.index);
    expect(await git(value.workspace, ["status", "--porcelain", "--untracked-files=all"])).toBe(before.status);
  }, GIT_TEST_TIMEOUT);

  it("records a clear reason instead of failing the run", async () => {
    const value = await fixture(CONFLICTING);
    const old = await prepare(value, { fake: (argv) => (argv.includes("version") ? "git version 2.37.1" : undefined) });
    expect(old).toEqual({ status: "unavailable", reason: expect.stringContaining("older than 2.38") });
    const missing = await prepare(value, { fetch: baseBranchFetch(value.main, 404) });
    expect(missing).toEqual({ status: "unavailable", reason: expect.stringContaining("reading the base branch main failed (404)") });
  }, GIT_TEST_TIMEOUT);
});

function mergeAction(sequence: number, operationId: string): RunnerActionV1 {
  return { schemaVersion: "gardener.runner.action/v1", sequence, operationId, timeoutMs: 60_000, kind: "repository.merge_base" };
}

function captureAction(sequence: number, operationId: string, baseSha: string): RunnerActionV1 {
  return { schemaVersion: "gardener.runner.action/v1", sequence, operationId, timeoutMs: 60_000, kind: "repository.capture", baseSha, maxOutputBytes: 4 * 1_024 * 1_024 };
}

async function planning(value: Fixture, merge?: MergePreparation) {
  const preparation = merge ?? await prepare(value);
  const executor = await createPlanningExecutor({ workspace: value.workspace, runnerTemp: value.runnerTemp, baseSha: value.head, merge: preparation });
  return { executor, merge: preparation };
}

type Captured =
  | { error: string }
  | { envelope: Extract<ReturnType<typeof runnerCaptureResultV1Schema.parse>, { status: "captured" }>; manifest: ReturnType<typeof taskCaptureManifestV1Schema.parse> };

async function captured(executor: Awaited<ReturnType<typeof planning>>["executor"], value: Fixture, sequence = 10): Promise<Captured> {
  const result = await executor.execute(captureAction(sequence, `op_capture_${sequence}`, value.head));
  if (result.status !== "completed") return { error: result.stderr };
  const envelope = runnerCaptureResultV1Schema.parse(JSON.parse(result.stdout));
  if (envelope.status !== "captured") return { error: "unchanged" };
  return { envelope, manifest: taskCaptureManifestV1Schema.parse(JSON.parse(envelope.manifestJson)) };
}

describe("repository.merge_base", () => {
  it("writes the merge into the working tree only, once", async () => {
    const value = await fixture(CONFLICTING);
    const { executor } = await planning(value);
    const index = await git(value.workspace, ["ls-files", "-s"]);
    const first = await executor.execute(mergeAction(1, "op_merge"));
    expect(first.status).toBe("completed");
    expect(runnerMergeBaseResultV1Schema.parse(JSON.parse(first.stdout))).toEqual({
      schemaVersion: "gardener.runner.merge-base-result/v1",
      status: "conflicted",
      pullNumber: 7, branch: "feature", expectedHeadSha: value.head, baseBranch: "main", baseSha: value.main, mergeBaseSha: value.mergeBase,
      conflictedFiles: ["d.txt", "f.txt"], changedFileCount: 2, messages: expect.stringContaining("CONFLICT"),
    });
    expect(await git(value.workspace, ["ls-files", "-s"])).toBe(index);
    expect(await readFile(path.join(value.workspace, "f.txt"), "utf8")).toMatch(/^<<<<<<< /m);
    expect(await readFile(path.join(value.workspace, "n.txt"), "utf8")).toBe("new\n");

    // A second call, even under another id, writes nothing.
    await writeFile(path.join(value.workspace, "f.txt"), "a\nRESOLVED\nc\n");
    const second = await executor.execute(mergeAction(2, "op_merge_again"));
    expect(second.stdout).toBe(first.stdout);
    expect(await readFile(path.join(value.workspace, "f.txt"), "utf8")).toBe("a\nRESOLVED\nc\n");
  }, GIT_TEST_TIMEOUT);

  it("refuses a working tree that already changed, and lets a restored tree retry", async () => {
    const value = await fixture(CONFLICTING);
    const { executor } = await planning(value);
    await writeFile(path.join(value.workspace, "same.txt"), "edited\n");
    const refused = await executor.execute(mergeAction(1, "op_merge"));
    expect(refused).toMatchObject({ status: "failed", exitCode: 1 });
    expect(JSON.parse(refused.stdout)).toMatchObject({ status: "refused" });
    expect(refused.stderr).toMatch(/already differs .*same\.txt.*merge first, then resolve/);
    await writeFile(path.join(value.workspace, "same.txt"), "same\n");
    expect((await executor.execute(mergeAction(2, "op_merge_retry"))).status).toBe("completed");
  }, GIT_TEST_TIMEOUT);

  it("refuses without a prepared merge, with the recorded reason", async () => {
    const value = await fixture(CONFLICTING);
    const none = await createPlanningExecutor({ workspace: value.workspace, runnerTemp: value.runnerTemp, baseSha: value.head });
    expect((await none.execute(mergeAction(1, "op_merge"))).stderr).toMatch(/did not prepare a merge/);
    const { executor } = await planning(value, { status: "unavailable", reason: "git is too old" });
    expect((await executor.execute(mergeAction(1, "op_merge"))).stderr).toBe("git is too old");
  }, GIT_TEST_TIMEOUT);

  it("refuses a merge that changes .gitattributes, .gitmodules or a submodule", async () => {
    const value = await fixture({ base: { "a.txt": "a\n" }, feature: { "a.txt": "A\n" }, main: { "docs/.gitattributes": "*.md text\n" } });
    const { executor } = await planning(value);
    const refused = await executor.execute(mergeAction(1, "op_merge"));
    expect(refused.stderr).toMatch(/docs\/\.gitattributes.*a person must merge/);
    await expect(stat(path.join(value.workspace, "docs/.gitattributes"))).rejects.toMatchObject({ code: "ENOENT" });
  }, GIT_TEST_TIMEOUT);

  it("refuses once the capture has started", async () => {
    const value = await fixture(CONFLICTING);
    const { executor } = await planning(value);
    await writeFile(path.join(value.workspace, "same.txt"), "edited\n");
    await executor.execute(captureAction(1, "op_capture", value.head));
    expect((await executor.execute(mergeAction(2, "op_merge"))).stderr).toMatch(/capture has started/);
  }, GIT_TEST_TIMEOUT);
});

describe("merge capture", () => {
  async function merged(files: { base: Files; feature: Files; main: Files } = CONFLICTING) {
    const value = await fixture(files);
    const { executor } = await planning(value);
    expect((await executor.execute(mergeAction(1, "op_merge"))).status).toBe("completed");
    return { value, executor };
  }

  it("captures a resolved merge with its base and conflicted paths", async () => {
    const { value, executor } = await merged();
    await writeFile(path.join(value.workspace, "f.txt"), "a\nRESOLVED\nc\n");
    const result = await captured(executor, value);
    if (!("manifest" in result)) throw new Error(result.error);
    expect(result.manifest.files.map((file) => [file.path, file.status])).toEqual([["f.txt", "modified"], ["n.txt", "added"]]);
    expect(result.manifest.merge).toEqual({ baseSha: value.main, conflictedPaths: ["d.txt", "f.txt"] });
    expect(result.envelope.ref.merge).toEqual(result.manifest.merge);
  }, GIT_TEST_TIMEOUT);

  it("accepts a conflicted path resolved to the head's version, so absent from the capture", async () => {
    const { value, executor } = await merged();
    await writeFile(path.join(value.workspace, "f.txt"), "a\nFEATURE\nc\n");
    const result = await captured(executor, value);
    if (!("manifest" in result)) throw new Error(result.error);
    expect(result.manifest.files.map((file) => file.path)).toEqual(["n.txt"]);
  }, GIT_TEST_TIMEOUT);

  it("refuses conflict markers left in a conflicted file", async () => {
    const { value, executor } = await merged();
    expect(await captured(executor, value)).toEqual({ error: expect.stringMatching(/f\.txt: it still holds a conflict marker/) });
  }, GIT_TEST_TIMEOUT);

  it("refuses anything outside the conflicted files that is not git's merge exactly", async () => {
    const changed = await merged();
    await writeFile(path.join(changed.value.workspace, "f.txt"), "a\nRESOLVED\nc\n");
    await writeFile(path.join(changed.value.workspace, "n.txt"), "new, edited\n");
    expect(await captured(changed.executor, changed.value)).toEqual({ error: expect.stringMatching(/n\.txt: .*differs from the merge/) });

    const extra = await merged();
    await writeFile(path.join(extra.value.workspace, "f.txt"), "a\nRESOLVED\nc\n");
    await writeFile(path.join(extra.value.workspace, "same.txt"), "slipped in\n");
    expect(await captured(extra.executor, extra.value)).toEqual({ error: expect.stringMatching(/same\.txt: .*the merge does not change this path/) });

    const missing = await merged();
    await writeFile(path.join(missing.value.workspace, "f.txt"), "a\nRESOLVED\nc\n");
    await unlink(path.join(missing.value.workspace, "n.txt"));
    expect(await captured(missing.executor, missing.value)).toEqual({ error: expect.stringMatching(/n\.txt, which the merge changes, is no longer changed/) });
  }, GIT_TEST_TIMEOUT);

  describe("protected paths", () => {
    const workflow = ".github/workflows/ci.yml";
    const files = {
      base: { [workflow]: "on: push\n", "a.txt": "a\n" },
      feature: { [workflow]: "on: [push]\n" },
      main: { [workflow]: "on: [push, pull_request]\n" },
    };

    it("accepts one only exactly as the base commit has it, and marks it", async () => {
      const { value, executor } = await merged(files);
      await writeFile(path.join(value.workspace, workflow), "on: [push, pull_request]\n");
      const result = await captured(executor, value);
      if (!("manifest" in result)) throw new Error(result.error);
      expect(result.manifest.files).toEqual([expect.objectContaining({ path: workflow, status: "modified", baseIdentical: true })]);
    }, GIT_TEST_TIMEOUT);

    it("refuses any other version, as a plain capture does", async () => {
      const { value, executor } = await merged(files);
      await writeFile(path.join(value.workspace, workflow), "on: [push, workflow_dispatch]\n");
      expect(await captured(executor, value)).toEqual({ error: expect.stringMatching(/Cannot capture \.github\/workflows\/ci\.yml: a run may not rewrite workflows/) });
    }, GIT_TEST_TIMEOUT);

    it("accepts a clean merge's protected change, which is the base commit's", async () => {
      const { value, executor } = await merged({ base: files.base, feature: { "a.txt": "A\n" }, main: files.main });
      const result = await captured(executor, value);
      if (!("manifest" in result)) throw new Error(result.error);
      expect(result.manifest.files).toEqual([expect.objectContaining({ path: workflow, baseIdentical: true })]);
      expect(result.manifest.merge).toEqual({ baseSha: value.main, conflictedPaths: [] });
    }, GIT_TEST_TIMEOUT);
  });

  it("leaves a capture without the merge tool exactly a plain capture", async () => {
    const value = await fixture(CONFLICTING);
    const { executor } = await planning(value);
    await writeFile(path.join(value.workspace, "same.txt"), "edited\n");
    const result = await captured(executor, value);
    if (!("manifest" in result)) throw new Error(result.error);
    expect(result.manifest.merge).toBeUndefined();
    expect(result.envelope.ref.merge).toBeUndefined();
    expect(result.manifest.files).toEqual([expect.not.objectContaining({ baseIdentical: true })]);
  }, GIT_TEST_TIMEOUT);
});
