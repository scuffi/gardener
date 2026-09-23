import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CAPTURE_FILE_MAX_BYTES, CAPTURE_TOTAL_MAX_BYTES } from "@gardener/contracts";
import type { TaskCaptureFileV1, TaskCaptureManifestV1, TaskCaptureRefV1 } from "@gardener/contracts";
import { WorkingTreeCapture, verifyCaptureArtifact } from "../src/capture";

/** Every case shells out to real Git several times, which is slow on macOS. */
const GIT_TEST_TIMEOUT = 60_000;
const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkingTreeCapture", () => {
  it("captures every supported mode, binary content, and deletions exactly once", async () => {
    const { capture, workspace } = await fixture({
      "text.txt": "one\n",
      "script.sh": "#!/bin/sh\necho hi\n",
      "keep.txt": "keep\n",
      "drop.txt": "drop\n",
      "binary.bin": Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00]),
    }, { executable: ["script.sh"], symlinks: { "link.txt": "text.txt" } });

    await writeFile(path.join(workspace, "text.txt"), "two\n");
    await writeFile(path.join(workspace, "binary.bin"), Buffer.from([0x00, 0x02, 0xff]));
    await writeFile(path.join(workspace, "added.txt"), "added\n");
    await unlink(path.join(workspace, "drop.txt"));
    await chmod(path.join(workspace, "script.sh"), 0o644);

    const result = await capture.capture();
    if (result.status !== "captured") throw new Error("expected a capture");

    expect(result.manifest.files).toEqual([
      { path: "added.txt", status: "added", mode: "100644", sizeBytes: 6, sha256: sha256("added\n") },
      { path: "binary.bin", status: "modified", mode: "100644", sizeBytes: 3, sha256: sha256(Buffer.from([0x00, 0x02, 0xff])) },
      { path: "drop.txt", status: "deleted" },
      { path: "script.sh", status: "modified", mode: "100644", sizeBytes: 18, sha256: sha256("#!/bin/sh\necho hi\n") },
      { path: "text.txt", status: "modified", mode: "100644", sizeBytes: 4, sha256: sha256("two\n") },
    ]);
    expect(result.manifest.totalBytes).toBe(6 + 3 + 18 + 4);
    expect(result.manifest.truncated).toBe(false);
    expect(result.ref).toMatchObject({ baseSha: capture.baseSha, fileCount: 5, sizeBytes: 31 });
    expect(JSON.stringify(result)).not.toContain("added\n");
    expect(Object.keys(result)).toEqual(["status", "ref", "manifest", "directory"]);

    const stored = await readFile(path.join(result.directory, "content", sha256("added\n")));
    expect(stored.toString("utf8")).toBe("added\n");
    expect(result.ref.manifestSha256).toBe(sha256(await readFile(path.join(result.directory, "manifest.json"))));
  }, GIT_TEST_TIMEOUT);

  it("captures an executable bit change and a new symlink with the link target as content", async () => {
    const { capture, workspace } = await fixture({ "tool.sh": "#!/bin/sh\n", "target.txt": "t\n" });
    await chmod(path.join(workspace, "tool.sh"), 0o755);
    await symlink("target.txt", path.join(workspace, "alias.txt"));

    const result = await capture.capture();
    if (result.status !== "captured") throw new Error("expected a capture");
    expect(result.manifest.files).toEqual([
      { path: "alias.txt", status: "added", mode: "120000", sizeBytes: 10, sha256: sha256("target.txt") },
      { path: "tool.sh", status: "modified", mode: "100755", sizeBytes: 10, sha256: sha256("#!/bin/sh\n") },
    ]);
    const link = await readFile(path.join(result.directory, "content", sha256("target.txt")));
    expect(link.toString("utf8")).toBe("target.txt");
  }, GIT_TEST_TIMEOUT);

  it("represents a rename as a deletion plus an addition", async () => {
    const { capture, workspace } = await fixture({ "old/name.txt": "body\n" });
    await mkdir(path.join(workspace, "new"), { recursive: true });
    await writeFile(path.join(workspace, "new/name.txt"), "body\n");
    await unlink(path.join(workspace, "old/name.txt"));

    const result = await capture.capture();
    if (result.status !== "captured") throw new Error("expected a capture");
    expect(result.manifest.files).toEqual([
      { path: "new/name.txt", status: "added", mode: "100644", sizeBytes: 5, sha256: sha256("body\n") },
      { path: "old/name.txt", status: "deleted" },
    ]);
  }, GIT_TEST_TIMEOUT);

  it("never follows a directory symlink and never captures outside the workspace", async () => {
    const { capture, workspace } = await fixture({ "keep.txt": "k\n" });
    const outside = await temporaryDirectory();
    await writeFile(path.join(outside, "secret.txt"), "secret\n");
    await symlink(outside, path.join(workspace, "escape"));
    await writeFile(path.join(workspace, "touched.txt"), "t\n");

    const result = await capture.capture();
    if (result.status !== "captured") throw new Error("expected a capture");
    const paths = result.manifest.files.map((file) => file.path);
    expect(paths).toEqual(["escape", "touched.txt"]);
    expect(paths.some((entry) => entry.includes("secret"))).toBe(false);
    expect(result.manifest.files[0]).toMatchObject({ mode: "120000", sha256: sha256(outside) });
    expect(JSON.stringify(result.manifest)).not.toContain("secret");
  }, GIT_TEST_TIMEOUT);

  it("excludes Git internals, the runner home, and Git-ignored paths", async () => {
    const { capture, workspace } = await fixture({ ".gitignore": "ignored/\n*.log\n", "src/keep.ts": "k\n" });
    await mkdir(path.join(workspace, "ignored"), { recursive: true });
    await writeFile(path.join(workspace, "ignored/blob.txt"), "ignored\n");
    await writeFile(path.join(workspace, "debug.log"), "noise\n");
    await mkdir(path.join(workspace, ".gardener/runner-home/.cache"), { recursive: true });
    await writeFile(path.join(workspace, ".gardener/runner-home/.cache/token"), "secret\n");
    await writeFile(path.join(workspace, ".git/hooks-note"), "internal\n");
    await writeFile(path.join(workspace, "src/new.ts"), "n\n");

    const result = await capture.capture();
    if (result.status !== "captured") throw new Error("expected a capture");
    expect(result.manifest.files.map((file) => file.path)).toEqual(["src/new.ts"]);
  }, GIT_TEST_TIMEOUT);

  it("applies path filters, rejects invalid filters, and reports an unchanged tree", async () => {
    const { capture, workspace } = await fixture({ "a/one.txt": "1\n", "b/two.txt": "2\n" });
    expect(await capture.capture()).toEqual({ status: "unchanged" });

    await writeFile(path.join(workspace, "a/one.txt"), "changed\n");
    await writeFile(path.join(workspace, "b/two.txt"), "changed\n");

    const scoped = await capture.capture({ paths: ["a"] });
    if (scoped.status !== "captured") throw new Error("expected a capture");
    expect(scoped.manifest.files.map((file) => file.path)).toEqual(["a/one.txt"]);

    const exact = await capture.capture({ paths: ["b/two.txt"] });
    if (exact.status !== "captured") throw new Error("expected a capture");
    expect(exact.manifest.files.map((file) => file.path)).toEqual(["b/two.txt"]);

    await expect(capture.capture({ paths: ["../escape"] })).rejects.toThrow(/escapes the workspace/);
    await expect(capture.capture({ paths: ["/abs"] })).rejects.toThrow(/Unsupported repository path/);
    await expect(capture.capture({ paths: [] })).rejects.toThrow(/non-empty array/);
    await expect(capture.capture({ paths: ["a", "a"] })).rejects.toThrow(/unique/);
  }, GIT_TEST_TIMEOUT);

  it("enforces optional limits only when supplied and rejects invalid limits", async () => {
    const { capture, workspace } = await fixture({ "one.txt": "1\n" });
    await writeFile(path.join(workspace, "one.txt"), "a".repeat(64));
    await writeFile(path.join(workspace, "two.txt"), "b".repeat(64));

    await expect(capture.capture({ maxBytes: 100 })).rejects.toThrow(/maxBytes=100/);
    await expect(capture.capture({ maxFiles: 1 })).rejects.toThrow(/maxFiles=1/);
    await expect(capture.capture({ maxBytes: 0 })).rejects.toThrow(/positive safe integer/);
    await expect(capture.capture({ maxFiles: 1.5 })).rejects.toThrow(/positive safe integer/);

    const unlimited = await capture.capture();
    if (unlimited.status !== "captured") throw new Error("expected a capture");
    expect(unlimited.manifest.files).toHaveLength(2);
    expect(unlimited.manifest.totalBytes).toBe(128);
  }, GIT_TEST_TIMEOUT);

  /**
   * The module must not hold file bytes whole in memory, and an over-limit
   * change must be abandoned while streaming rather than after being read.
   * A multi-megabyte payload crosses many stream chunks, so a regression that
   * reintroduced buffering would have to buffer it all to pass the digest.
   */
  it("streams multi-megabyte content and abandons an over-limit change mid-stream", async () => {
    const { capture, workspace } = await fixture({ "big.bin": "seed\n" });
    const big = Buffer.alloc(4 * 1_024 * 1_024, 0x61);
    await writeFile(path.join(workspace, "big.bin"), big);

    await expect(capture.capture({ maxBytes: 1_024 })).rejects.toThrow(/maxBytes=1024/);
    expect(await readdir(path.join(workspace, ".."))).toBeDefined();

    const result = await capture.capture();
    if (result.status !== "captured") throw new Error("expected a capture");
    expect(result.manifest.files).toEqual([
      { path: "big.bin", status: "modified", mode: "100644", sizeBytes: big.byteLength, sha256: sha256(big) },
    ]);
    const stored = await stat(path.join(result.directory, "content", sha256(big)));
    expect(stored.size).toBe(big.byteLength);
    await expect(verifyCaptureArtifact(result.directory, result.ref)).resolves.toMatchObject({ ref: result.ref });
  }, GIT_TEST_TIMEOUT);

  it("rejects a tracked path replaced by a special file and a drifted base commit", async () => {
    const { capture, workspace } = await fixture({ "pipe.txt": "regular\n", "keep.txt": "k\n" });
    await unlink(path.join(workspace, "pipe.txt"));
    const madeFifo = await execFileAsync("mkfifo", [path.join(workspace, "pipe.txt")]).then(() => true, () => false);
    if (madeFifo) {
      await expect(capture.capture()).rejects.toThrow(/only regular files and symbolic links/);
      await unlink(path.join(workspace, "pipe.txt"));
    }

    await writeFile(path.join(workspace, "keep.txt"), "changed\n");
    await execFileAsync("git", ["-C", workspace, "commit", "--allow-empty", "-m", "drift"], { env: gitEnvironment() });
    await expect(capture.capture()).rejects.toThrow(/HEAD moved/);
  }, GIT_TEST_TIMEOUT);

  it("rejects a workspace whose index tracks reserved runner paths or a mismatched base", async () => {
    const workspace = await temporaryDirectory();
    const runnerTemp = await temporaryDirectory();
    await initializeRepository(workspace, { ".gardener/runner-home/config": "x\n" });
    const head = await headSha(workspace);
    await expect(WorkingTreeCapture.initialize({ workspace, runnerTemp, baseSha: head }))
      .rejects.toThrow(/reserved Gardener runner path/);

    const clean = await temporaryDirectory();
    await initializeRepository(clean, { "a.txt": "a\n" });
    await expect(WorkingTreeCapture.initialize({ workspace: clean, runnerTemp, baseSha: "b".repeat(40) }))
      .rejects.toThrow(/does not match the expected base commit/);
    await expect(WorkingTreeCapture.initialize({ workspace: clean, runnerTemp, baseSha: "nope" }))
      .rejects.toThrow(/Invalid base commit SHA-1/);
    await expect(WorkingTreeCapture.initialize({ workspace: clean, runnerTemp: path.join(clean, "temp"), baseSha: await headSha(clean) }))
      .rejects.toThrow(/does not exist/);

    await mkdir(path.join(clean, "temp"), { recursive: true });
    await expect(WorkingTreeCapture.initialize({ workspace: clean, runnerTemp: path.join(clean, "temp"), baseSha: await headSha(clean) }))
      .rejects.toThrow(/must not be written inside the workspace/);
  }, GIT_TEST_TIMEOUT);

  it("handles paths with spaces, unicode, and quotes deterministically and idempotently", async () => {
    const { capture, workspace } = await fixture({ "plain.txt": "p\n" });
    const awkward = ["a file with spaces.txt", "üñî çødé.txt", "quote'name\".txt", "dash-and_under.txt"];
    for (const name of awkward) await writeFile(path.join(workspace, name), `${name}\n`);

    const first = await capture.capture();
    const second = await capture.capture();
    if (first.status !== "captured" || second.status !== "captured") throw new Error("expected captures");
    expect(second.ref).toEqual(first.ref);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.directory).toBe(first.directory);
    expect(first.manifest.files.map((file) => file.path)).toEqual([...awkward].sort(
      (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    ));
    expect(first.ref.captureId).toMatch(/^cap_[0-9a-f]{64}$/);
  }, GIT_TEST_TIMEOUT);
});

/**
 * `actions/checkout` leaves submodules uninitialized, which is the state almost
 * every real capture runs against. Failing it would break every repository that
 * merely contains a submodule.
 */
describe("WorkingTreeCapture submodules", () => {
  it("captures cleanly when a submodule is present but uninitialized", async () => {
    const { workspace, runnerTemp } = await submoduleFixture({ initialize: false });
    const capture = await WorkingTreeCapture.initialize({ workspace, runnerTemp, baseSha: await headSha(workspace) });

    expect(await capture.capture()).toEqual({ status: "unchanged" });

    await writeFile(path.join(workspace, "root.txt"), "changed\n");
    const result = await capture.capture();
    if (result.status !== "captured") throw new Error("expected a capture");
    expect(result.manifest.files.map((file) => file.path)).toEqual(["root.txt"]);
  }, GIT_TEST_TIMEOUT);

  it("captures cleanly when an initialized submodule is at its recorded commit", async () => {
    const { workspace, runnerTemp } = await submoduleFixture({ initialize: true });
    const capture = await WorkingTreeCapture.initialize({ workspace, runnerTemp, baseSha: await headSha(workspace) });
    expect(await capture.capture()).toEqual({ status: "unchanged" });
  }, GIT_TEST_TIMEOUT);

  it("refuses a dirty submodule worktree", async () => {
    const { workspace, runnerTemp } = await submoduleFixture({ initialize: true });
    const capture = await WorkingTreeCapture.initialize({ workspace, runnerTemp, baseSha: await headSha(workspace) });
    await writeFile(path.join(workspace, "vendor/lib.txt"), "changed\n");
    await expect(capture.capture()).rejects.toThrow(/submodule changes are not capturable/);
  }, GIT_TEST_TIMEOUT);

  it("refuses a submodule moved to a different commit", async () => {
    const { workspace, runnerTemp } = await submoduleFixture({ initialize: true });
    const capture = await WorkingTreeCapture.initialize({ workspace, runnerTemp, baseSha: await headSha(workspace) });

    const vendor = path.join(workspace, "vendor");
    await writeFile(path.join(vendor, "lib.txt"), "moved\n");
    await execFileAsync("git", ["-C", vendor, "add", "-A"], { env: gitEnvironment() });
    await execFileAsync("git", ["-C", vendor, "commit", "-q", "-m", "moved"], { env: gitEnvironment() });
    expect((await git(vendor, ["status", "--porcelain"])).trim()).toBe("");

    await expect(capture.capture()).rejects.toThrow(/submodule changes are not capturable/);
  }, GIT_TEST_TIMEOUT);

  /**
   * `git add` on a directory that is itself a repository records a `160000`
   * gitlink and writes no `.gitmodules` entry. Deleting `.gitmodules` from a
   * real submodule leaves the same shape. Git then has nothing to report and
   * `git submodule status` exits 128, so the unchanged case has to be decided
   * from the worktree instead.
   */
  it("captures normally when an unmapped gitlink is left uninitialized", async () => {
    const { workspace, runnerTemp } = await embeddedGitlinkFixture({ populated: false });

    // The precondition: Git refuses to answer, and a fresh clone leaves the
    // gitlink as an empty directory rather than omitting it.
    await expect(git(workspace, ["submodule", "status", "--", "lib"])).rejects.toThrow(/no submodule mapping/);
    expect((await git(workspace, ["ls-files", "-s", "--", "lib"])).startsWith("160000 ")).toBe(true);
    expect(await readdir(path.join(workspace, "lib"))).toEqual([]);

    const capture = await WorkingTreeCapture.initialize({ workspace, runnerTemp, baseSha: await headSha(workspace) });
    expect(await capture.capture()).toEqual({ status: "unchanged" });

    await writeFile(path.join(workspace, "root.txt"), "changed\n");
    const result = await capture.capture();
    if (result.status !== "captured") throw new Error("expected a capture");
    expect(result.manifest.files.map((file) => file.path)).toEqual(["root.txt"]);
  }, GIT_TEST_TIMEOUT);

  /**
   * The other half of the same branch: a populated unmapped gitlink is a nested
   * repository whose commit cannot be compared against the recorded one, so the
   * 128 must not be read as "nothing to check". This fixture is also *moved* —
   * the nested HEAD differs from the gitlink — which is exactly the work that
   * would be silently dropped if the failure were swallowed.
   */
  it("refuses an unmapped gitlink whose worktree is populated", async () => {
    const { workspace, runnerTemp } = await embeddedGitlinkFixture({ populated: true });
    const lib = path.join(workspace, "lib");
    await writeFile(path.join(lib, "lib.txt"), "moved\n");
    await execFileAsync("git", ["-C", lib, "add", "-A"], { env: gitEnvironment() });
    await execFileAsync("git", ["-C", lib, "commit", "-q", "-m", "moved"], { env: gitEnvironment() });

    const capture = await WorkingTreeCapture.initialize({ workspace, runnerTemp, baseSha: await headSha(workspace) });
    await writeFile(path.join(workspace, "root.txt"), "changed\n");

    await expect(capture.capture()).rejects.toThrow(
      /Cannot capture lib: it is a Git submodule \(gitlink\) with no \.gitmodules mapping and a populated worktree/,
    );
  }, GIT_TEST_TIMEOUT);
});

/**
 * `core.attributesFile` and `core.excludesFile` have built-in default paths
 * under `$XDG_CONFIG_HOME`/`$HOME`, so neither `GIT_CONFIG_GLOBAL=/dev/null`
 * nor `GIT_ATTR_NOSYSTEM` disables them. `repository.exec` shares this uid and
 * inherits the runner's HOME, so both are writable by the model and neither is
 * covered by an authority digest. Only the pinned command line closes them.
 */
describe("WorkingTreeCapture default user Git files", () => {
  it("ignores a planted user attributes and ignore file", async () => {
    const { capture, workspace } = await fixture({
      "crlf.txt": "line1\r\nline2\r\n",
      "plain.txt": "plain\n",
    });
    await writeFile(path.join(workspace, "plain.txt"), "edited\n");
    await writeFile(path.join(workspace, "extra.txt"), "extra\n");

    const clean = await capture.capture();
    if (clean.status !== "captured") throw new Error("expected a capture");
    expect(clean.manifest.files.map((file) => file.path)).toEqual(["extra.txt", "plain.txt"]);

    const home = await temporaryDirectory();
    await mkdir(path.join(home, ".config", "git"), { recursive: true });
    // `* text` renormalizes every path, so an untouched CRLF file would hash
    // differently from its index blob and be captured with rewritten bytes.
    // `text` is an attribute rather than a filter, so it routes around the
    // unresolvable-filter refusal entirely.
    await writeFile(path.join(home, ".config", "git", "attributes"), "* text\n");
    await writeFile(path.join(home, ".config", "git", "ignore"), "extra.txt\n");

    await withEnvironment({ HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") }, async () => {
      // Prove the plant is load-bearing: without the two pinned settings Git
      // reads both files and changes both classification inputs.
      const legacy = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never"];
      const indexed = (await git(workspace, ["ls-files", "-s", "--", "crlf.txt"])).split(/\s+/)[1];
      const { stdout: renormalized } = await execFileAsync(
        "git", ["-C", workspace, ...legacy, "hash-object", "--", "crlf.txt"],
        { env: { ...gitEnvironment(), HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") } },
      );
      expect(renormalized.trim()).not.toBe(indexed);
      const { stdout: hidden } = await execFileAsync(
        "git", ["-C", workspace, ...legacy, "ls-files", "--others", "--exclude-standard"],
        { env: { ...gitEnvironment(), HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") } },
      );
      expect(hidden).not.toContain("extra.txt");

      const planted = await capture.capture();
      if (planted.status !== "captured") throw new Error("expected a capture");
      expect(planted.manifest).toEqual(clean.manifest);
      expect(planted.ref).toEqual(clean.ref);
    });
  }, GIT_TEST_TIMEOUT);
});

/**
 * The contract's ceilings are what the Git Data API can actually apply, so a
 * capture beyond them is unusable. Enforcing them only while streaming would
 * still read and store every oversized byte first, so the decisive assertion in
 * each case is that the object database did not grow.
 */
describe("WorkingTreeCapture size ceilings", () => {
  it("refuses an oversized added file from its size alone, without hashing or storing it", async () => {
    const { capture, workspace } = await fixture({ "seed.txt": "s\n" });
    const huge = path.join(workspace, "huge.bin");
    await writeFile(huge, "");
    await truncate(huge, CAPTURE_FILE_MAX_BYTES + 1);
    if (!(await isSparse(huge))) return;

    const before = await countLooseObjects(workspace);
    await expect(capture.capture()).rejects.toThrow(
      new RegExp(`Capture content for huge\\.bin exceeds the ${CAPTURE_FILE_MAX_BYTES}-byte capture ceiling`),
    );
    // An untracked path is in the change set whatever it hashes to, so it is
    // refused before `hash-object` reads it at all.
    expect(await countLooseObjects(workspace)).toBe(before);
  }, GIT_TEST_TIMEOUT);

  it("refuses an aggregate beyond the contract ceiling with no maxBytes supplied", async () => {
    const { capture, workspace } = await fixture({ "seed.txt": "s\n" });
    const count = Math.floor(CAPTURE_TOTAL_MAX_BYTES / CAPTURE_FILE_MAX_BYTES) + 1;
    for (let index = 0; index < count; index += 1) {
      const target = path.join(workspace, `part-${String(index).padStart(3, "0")}.bin`);
      await writeFile(target, "");
      await truncate(target, CAPTURE_FILE_MAX_BYTES);
      if (index === 0 && !(await isSparse(target))) return;
    }

    const before = await countLooseObjects(workspace);
    // Every file is individually legal; only the sum is not.
    await expect(capture.capture()).rejects.toThrow(
      new RegExp(`Capture exceeds the ${CAPTURE_TOTAL_MAX_BYTES}-byte capture ceiling`),
    );
    expect(await countLooseObjects(workspace)).toBe(before);
  }, GIT_TEST_TIMEOUT);

  it("refuses an over-limit tracked change before it reaches the object database", async () => {
    const { capture, workspace } = await fixture({ "big.bin": "seed\n" });
    await writeFile(path.join(workspace, "big.bin"), Buffer.alloc(4 * 1_024 * 1_024, 0x61));

    const before = await countLooseObjects(workspace);
    // A tracked path must be hashed to know whether it changed — a read that
    // stores nothing — but the write is still gated behind the size check.
    await expect(capture.capture({ maxBytes: 1_024 })).rejects.toThrow(/Capture exceeds maxBytes=1024/);
    expect(await countLooseObjects(workspace)).toBe(before);
  }, GIT_TEST_TIMEOUT);

  /**
   * Worktree size is only an estimate of what Git stores, because a clean
   * filter may expand it. The streaming meter therefore stays authoritative
   * rather than becoming a redundant second opinion.
   */
  it("enforces the ceiling on canonical bytes when a clean filter expands content", async () => {
    const { capture, workspace } = await fixture(
      { ".gitattributes": "*.expand filter=balloon\n", "a.expand": "x\n" },
      { config: { "filter.balloon.clean": "awk '{ for (i = 0; i < 1000; i++) print }'" } },
    );
    await writeFile(path.join(workspace, "a.expand"), "yy\n");
    // Three bytes on disk, three thousand in the object database.
    expect((await stat(path.join(workspace, "a.expand"))).size).toBe(3);

    await expect(capture.capture({ maxBytes: 1_000 })).rejects.toThrow(/Capture exceeds maxBytes=1000/);

    const result = await capture.capture();
    if (result.status !== "captured") throw new Error("expected a capture");
    expect(result.manifest.totalBytes).toBe(3_000);
  }, GIT_TEST_TIMEOUT);
});

/**
 * Git's own filters decide what "changed" means. Hashing raw worktree bytes
 * would mark every file in a normalizing repository as modified and would
 * commit the worktree encoding instead of the canonical blob.
 */
describe("WorkingTreeCapture attribute and filter semantics", () => {
  it("does not report untouched files as modified under text eol=crlf", async () => {
    const { capture, workspace } = await fixture(
      { ".gitattributes": "* text eol=crlf\n", "text.txt": "line1\nline2\n", "other.txt": "a\nb\n" },
      { rehydrate: true },
    );
    expect((await readFile(path.join(workspace, "text.txt"))).includes(Buffer.from("\r\n"))).toBe(true);
    expect((await git(workspace, ["status", "--porcelain"])).trim()).toBe("");

    expect(await capture.capture()).toEqual({ status: "unchanged" });
  }, GIT_TEST_TIMEOUT);

  it("materializes the canonical LF blob when a CRLF worktree file changes", async () => {
    const { capture, workspace } = await fixture(
      { ".gitattributes": "* text eol=crlf\n", "text.txt": "line1\nline2\n" },
      { rehydrate: true },
    );
    await writeFile(path.join(workspace, "text.txt"), "line1\r\nCHANGED\r\n");

    const result = await capture.capture();
    if (result.status !== "captured") throw new Error("expected a capture");
    expect(result.manifest.files).toEqual([
      { path: "text.txt", status: "modified", mode: "100644", sizeBytes: 14, sha256: sha256("line1\nCHANGED\n") },
    ]);
    const stored = await readFile(path.join(result.directory, "content", sha256("line1\nCHANGED\n")));
    expect(stored.toString("utf8")).toBe("line1\nCHANGED\n");
    expect(stored.includes(Buffer.from("\r\n"))).toBe(false);
  }, GIT_TEST_TIMEOUT);

  it("materializes clean-filtered content for a configured filter driver", async () => {
    const { capture, workspace } = await fixture(
      { ".gitattributes": "*.secret filter=redact\n", "a.secret": "has SECRET here\n" },
      { config: { "filter.redact.clean": "sed s/SECRET/REDACTED/" } },
    );
    await writeFile(path.join(workspace, "a.secret"), "has SECRET here and more\n");

    const result = await capture.capture();
    if (result.status !== "captured") throw new Error("expected a capture");
    const canonical = "has REDACTED here and more\n";
    expect(result.manifest.files).toEqual([
      { path: "a.secret", status: "modified", mode: "100644", sizeBytes: canonical.length, sha256: sha256(canonical) },
    ]);
    const stored = await readFile(path.join(result.directory, "content", sha256(canonical)));
    expect(stored.toString("utf8")).toBe(canonical);
    expect(stored.toString("utf8")).not.toContain("SECRET");
  }, GIT_TEST_TIMEOUT);

  /**
   * Git LFS lives in the user's global configuration, which capture pins away.
   * Capturing the worktree bytes would replace the pointer the repository
   * tracks with the object it points at, so the run must stop instead.
   */
  it("refuses a changed path whose declared filter driver is unavailable", async () => {
    const { capture, workspace } = await fixture({ ".gitattributes": "*.big filter=lfs\n", "data.big": "pointer\n" });
    await writeFile(path.join(workspace, "data.big"), "real object bytes\n");

    await expect(capture.capture()).rejects.toThrow(
      /Cannot capture data\.big: it uses the Git filter 'lfs', which is not available/,
    );
  }, GIT_TEST_TIMEOUT);

  it("captures a real Git LFS pointer file without substituting the object", async () => {
    const available = await execFileAsync("git", ["lfs", "version"], { env: gitEnvironment() }).then(() => true, () => false);
    if (!available) return;

    const { capture, workspace } = await fixture(
      { ".gitattributes": "*.bin filter=lfs -text\n", "seed.txt": "s\n" },
      { config: { "filter.lfs.clean": "git-lfs clean -- %f", "filter.lfs.smudge": "git-lfs smudge -- %f", "filter.lfs.required": "true" } },
    );
    await writeFile(path.join(workspace, "asset.bin"), Buffer.alloc(2_048, 0x7a));

    const result = await capture.capture();
    if (result.status !== "captured") throw new Error("expected a capture");
    expect(result.manifest.files.map((file) => file.path)).toEqual(["asset.bin"]);
    const asset = result.manifest.files[0];
    if (asset === undefined || asset.status === "deleted") throw new Error("expected an upserted asset");
    const stored = await readFile(path.join(result.directory, "content", asset.sha256));
    // The canonical blob is the LFS pointer, never the 2 KiB object.
    expect(stored.toString("utf8")).toContain("version https://git-lfs.github.com/spec/v1");
    expect(stored.byteLength).toBeLessThan(1_024);
  }, GIT_TEST_TIMEOUT);
});

/**
 * The model shares a uid with this process, so it can rewrite everything Git
 * consults. Capture must detect that its baseline moved and refuse, rather than
 * produce a change set the model defined.
 */
describe("WorkingTreeCapture hostile Git state after initialize", () => {
  it("refuses when the index is mutated after the snapshot", async () => {
    const { capture, workspace } = await fixture({ "a.txt": "a\n" });
    await writeFile(path.join(workspace, "new.txt"), "n\n");
    await execFileAsync("git", ["-C", workspace, "add", "new.txt"], { env: gitEnvironment() });

    await expect(capture.capture()).rejects.toThrow(/Git index changed during execution/);
  }, GIT_TEST_TIMEOUT);

  it("refuses when Git configuration is mutated after the snapshot", async () => {
    const { capture, workspace } = await fixture({ "a.txt": "a\n" });
    await writeFile(path.join(workspace, "a.txt"), "changed\n");
    await execFileAsync("git", ["-C", workspace, "config", "core.excludesFile", "/tmp/evil-excludes"], { env: gitEnvironment() });

    await expect(capture.capture()).rejects.toThrow(/Git configuration changed during execution/);
  }, GIT_TEST_TIMEOUT);

  it("refuses when private exclude rules are mutated after the snapshot", async () => {
    const { capture, workspace } = await fixture({ ".gitignore": "secrets/\n", "a.txt": "a\n" });
    await mkdir(path.join(workspace, "secrets"), { recursive: true });
    await writeFile(path.join(workspace, "secrets/key.pem"), "key\n");
    await appendFile(path.join(workspace, ".git/info/exclude"), "\n!secrets/\n");

    await expect(capture.capture()).rejects.toThrow(/Git exclude rules changed during execution/);
  }, GIT_TEST_TIMEOUT);

  it("refuses when a .gitattributes file is introduced after the snapshot", async () => {
    const { capture, workspace } = await fixture({ "a.txt": "a\n" });
    await writeFile(path.join(workspace, "a.txt"), "changed\n");
    await writeFile(path.join(workspace, ".gitattributes"), "* text eol=crlf\n");

    await expect(capture.capture()).rejects.toThrow(/Git attributes changed during execution \(\.gitattributes\)/);
  }, GIT_TEST_TIMEOUT);

  it("refuses when a tracked .gitattributes file is edited after the snapshot", async () => {
    const { capture, workspace } = await fixture({ ".gitattributes": "*.big filter=lfs\n", "a.txt": "a\n" });
    await writeFile(path.join(workspace, ".gitattributes"), "*.big filter=none\n");

    await expect(capture.capture()).rejects.toThrow(/Git attributes changed during execution/);
  }, GIT_TEST_TIMEOUT);

  /**
   * Git configuration is a multiset, not a map: `filter.*`, `include.path` and
   * friends may carry several values under one name. A digest rebuilt from a
   * parsed map keeps only the last one, so removing an earlier duplicate is
   * invisible to it while changing what Git actually does.
   */
  it("refuses when a duplicate filter value is removed after the snapshot", async () => {
    const workspace = await temporaryDirectory();
    const runnerTemp = await temporaryDirectory();
    await initializeRepository(workspace, { "a.txt": "a\n" });
    await git(workspace, ["config", "--add", "filter.dup.clean", "cat"]);
    await git(workspace, ["config", "--add", "filter.dup.clean", "tr a-z A-Z"]);

    const capture = await WorkingTreeCapture.initialize({ workspace, runnerTemp, baseSha: await headSha(workspace) });
    await writeFile(path.join(workspace, "a.txt"), "changed\n");
    await git(workspace, ["config", "--unset", "filter.dup.clean", "^cat$"]);

    // The last value — all a map would retain — is untouched, so only a digest
    // over Git's raw output can see this.
    expect((await git(workspace, ["config", "--get-all", "filter.dup.clean"])).trim().split("\n"))
      .toEqual(["tr a-z A-Z"]);

    await expect(capture.capture()).rejects.toThrow(/Git configuration changed during execution/);
  }, GIT_TEST_TIMEOUT);

  it("refuses when a duplicate include.path is removed after the snapshot", async () => {
    const workspace = await temporaryDirectory();
    const runnerTemp = await temporaryDirectory();
    await initializeRepository(workspace, { "a.txt": "a\n" });
    // Both includes define the same key with the same value, so the flattened
    // view is byte-identical whether one or both are present.
    const one = path.join(runnerTemp, "one.cfg");
    const two = path.join(runnerTemp, "two.cfg");
    await writeFile(one, "[gardener]\n\tshared = x\n");
    await writeFile(two, "[gardener]\n\tshared = x\n");
    await git(workspace, ["config", "--add", "include.path", one]);
    await git(workspace, ["config", "--add", "include.path", two]);

    const capture = await WorkingTreeCapture.initialize({ workspace, runnerTemp, baseSha: await headSha(workspace) });
    await writeFile(path.join(workspace, "a.txt"), "changed\n");
    await git(workspace, ["config", "--unset", "include.path", "one\\.cfg$"]);

    expect((await git(workspace, ["config", "--get-all", "gardener.shared"])).trim()).toBe("x");

    await expect(capture.capture()).rejects.toThrow(/Git configuration changed during execution/);
  }, GIT_TEST_TIMEOUT);
});

describe("verifyCaptureArtifact", () => {
  it("accepts the directory the plan-bound reference describes", async () => {
    const { result } = await capturedFixture();
    const verified = await verifyCaptureArtifact(result.directory, result.ref);
    expect(verified.ref).toEqual(result.ref);
    expect(verified.manifest).toEqual(result.manifest);
  }, GIT_TEST_TIMEOUT);

  it("detects blob tampering and inflation under the original reference", async () => {
    const { result, digest } = await capturedFixture();
    const blob = path.join(result.directory, "content", digest);

    await writeFile(blob, "tamper!\n", { mode: 0o600 });
    await expect(verifyCaptureArtifact(result.directory, result.ref)).rejects.toThrow(/content digest mismatch/);

    await writeFile(blob, "longer tamper\n", { mode: 0o600 });
    await expect(verifyCaptureArtifact(result.directory, result.ref)).rejects.toThrow(/content size mismatch/);
  }, GIT_TEST_TIMEOUT);

  /**
   * The decisive case. The model can rewrite the manifest *and* its blobs
   * together, producing a directory that is entirely self-consistent — it even
   * verifies against a reference derived from itself. Only the reference
   * carried inside the plan can reject it.
   */
  it("rejects a coherently rewritten artifact that is internally self-consistent", async () => {
    const { result } = await capturedFixture();
    const forged = await rewriteArtifact(result.directory, "attacker controlled bytes\n");

    await expect(verifyCaptureArtifact(result.directory, result.ref))
      .rejects.toThrow(/Capture manifest digest mismatch/);

    // Proves the rewrite was coherent rather than merely corrupt.
    const selfDerived = await verifyCaptureArtifact(result.directory, forged);
    expect(selfDerived.manifest.files[0]).toMatchObject({ sha256: sha256("attacker controlled bytes\n") });
    expect(forged.captureId).not.toBe(result.ref.captureId);
  }, GIT_TEST_TIMEOUT);

  it("rejects a reference whose scalar bindings disagree with the manifest", async () => {
    const { result } = await capturedFixture();
    const cases: [string, TaskCaptureRefV1][] = [
      ["base commit", { ...result.ref, baseSha: "c".repeat(40) }],
      ["file count", { ...result.ref, fileCount: result.ref.fileCount + 1 }],
      ["size", { ...result.ref, sizeBytes: result.ref.sizeBytes + 1 }],
      ["changes digest", { ...result.ref, changesSha256: "d".repeat(64) }],
      ["capture id", { ...result.ref, captureId: "cap_" + "e".repeat(64) }],
    ];
    for (const [, reference] of cases) {
      await expect(verifyCaptureArtifact(result.directory, reference)).rejects.toThrow(/mismatch/);
    }
  }, GIT_TEST_TIMEOUT);

  it("rejects an oversized or missing manifest without reading it whole", async () => {
    const { result } = await capturedFixture();
    await rm(path.join(result.directory, "manifest.json"));
    await expect(verifyCaptureArtifact(result.directory, result.ref)).rejects.toThrow();
  }, GIT_TEST_TIMEOUT);
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface FixtureOptions {
  executable?: readonly string[];
  symlinks?: Record<string, string>;
  config?: Record<string, string>;
  /** Re-checkout tracked files so worktree bytes reflect declared attributes. */
  rehydrate?: boolean;
}

async function fixture(
  files: Record<string, string | Buffer>,
  options: FixtureOptions = {},
): Promise<{ capture: WorkingTreeCapture; workspace: string; runnerTemp: string }> {
  const workspace = await temporaryDirectory();
  const runnerTemp = await temporaryDirectory();
  await initializeRepository(workspace, files, options);
  const capture = await WorkingTreeCapture.initialize({ workspace, runnerTemp, baseSha: await headSha(workspace) });
  return { capture, workspace, runnerTemp };
}

/** A completed single-file capture, used by the verification suite. */
async function capturedFixture(): Promise<{
  result: Extract<Awaited<ReturnType<WorkingTreeCapture["capture"]>>, { status: "captured" }>;
  digest: string;
}> {
  const { capture, workspace } = await fixture({ "one.txt": "1\n" });
  await writeFile(path.join(workspace, "one.txt"), "mutated\n");
  const result = await capture.capture();
  if (result.status !== "captured") throw new Error("expected a capture");
  expect((await stat(result.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(path.join(result.directory, "manifest.json"))).mode & 0o777).toBe(0o600);
  expect(await readdir(path.join(result.directory, "content"))).toEqual([sha256("mutated\n")]);
  return { result, digest: sha256("mutated\n") };
}

/**
 * Rewrites an artifact the way a same-uid attacker would: new bytes, a matching
 * blob name, and a manifest whose sizes, digests, and capture id are all
 * recomputed. Returns the reference the forged directory derives.
 */
async function rewriteArtifact(directory: string, replacement: string): Promise<TaskCaptureRefV1> {
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TaskCaptureManifestV1;
  const original = manifest.files[0];
  if (original === undefined || original.status === "deleted") throw new Error("fixture expects one upsert");

  const bytes = Buffer.from(replacement, "utf8");
  const sha = sha256(bytes);
  await rm(path.join(directory, "content", original.sha256), { force: true });
  await writeFile(path.join(directory, "content", sha), bytes, { mode: 0o600 });

  const files: TaskCaptureFileV1[] = [{ ...original, sizeBytes: bytes.byteLength, sha256: sha }];
  const forged: TaskCaptureManifestV1 = {
    ...manifest,
    files,
    totalBytes: bytes.byteLength,
    captureId: `cap_${sha256(identityStream(manifest.baseSha, files))}`,
  };
  const forgedBytes = Buffer.from(canonicalJson(forged), "utf8");
  await writeFile(manifestPath, forgedBytes, { mode: 0o600 });

  return {
    schemaVersion: "gardener.task-capture-ref/v1",
    captureId: forged.captureId,
    baseSha: forged.baseSha,
    manifestSha256: sha256(forgedBytes),
    changesSha256: sha256(changesStream(files)),
    fileCount: files.length,
    sizeBytes: forged.totalBytes,
  };
}

async function submoduleFixture(options: { initialize: boolean }): Promise<{ workspace: string; runnerTemp: string }> {
  const inner = await temporaryDirectory();
  await initializeRepository(inner, { "lib.txt": "lib\n" });
  const source = await temporaryDirectory();
  await initializeRepository(source, { "root.txt": "root\n" });
  await execFileAsync("git", [
    "-C", source, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendor",
  ], { env: gitEnvironment() });
  await execFileAsync("git", ["-C", source, "commit", "-q", "-m", "vendor"], { env: gitEnvironment() });

  const workspace = await temporaryDirectory();
  const runnerTemp = await temporaryDirectory();
  // Clone the way actions/checkout does: the gitlink is tracked, the submodule
  // is left uninitialized unless explicitly requested.
  await execFileAsync("git", ["clone", "-q", source, workspace], { env: gitEnvironment() });
  if (options.initialize) {
    await execFileAsync("git", [
      "-C", workspace, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init",
    ], { env: gitEnvironment() });
  }
  return { workspace, runnerTemp };
}

/**
 * A repository holding a `160000` gitlink with no `.gitmodules` entry, cloned
 * the way `actions/checkout` would. `git add` on an embedded repository is the
 * simplest way to produce the shape; Git warns and accepts it.
 */
async function embeddedGitlinkFixture(options: { populated: boolean }): Promise<{ workspace: string; runnerTemp: string }> {
  const inner = await temporaryDirectory();
  await initializeRepository(inner, { "lib.txt": "lib\n" });
  const source = await temporaryDirectory();
  await initializeRepository(source, { "root.txt": "root\n" });
  await execFileAsync("cp", ["-R", `${inner}/.`, path.join(source, "lib")]);
  await execFileAsync("git", ["-C", source, "add", "-A"], { env: gitEnvironment() });
  await execFileAsync("git", ["-C", source, "commit", "-q", "-m", "embedded"], { env: gitEnvironment() });

  const workspace = await temporaryDirectory();
  const runnerTemp = await temporaryDirectory();
  await execFileAsync("git", ["clone", "-q", source, workspace], { env: gitEnvironment() });
  // A clone materializes the gitlink as an empty directory; only an explicit
  // checkout of the nested repository populates it.
  if (options.populated) await execFileAsync("cp", ["-R", `${inner}/.`, path.join(workspace, "lib")]);
  return { workspace, runnerTemp };
}

async function initializeRepository(
  workspace: string,
  files: Record<string, string | Buffer>,
  options: FixtureOptions = {},
): Promise<void> {
  const environment = gitEnvironment();
  await execFileAsync("git", ["-C", workspace, "init", "-q", "-b", "main"], { env: environment });
  for (const [key, value] of Object.entries(options.config ?? {})) {
    await execFileAsync("git", ["-C", workspace, "config", key, value], { env: environment });
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(workspace, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  for (const relative of options.executable ?? []) await chmod(path.join(workspace, relative), 0o755);
  for (const [link, target] of Object.entries(options.symlinks ?? {})) {
    await symlink(target, path.join(workspace, link));
  }
  await execFileAsync("git", ["-C", workspace, "add", "-A"], { env: environment });
  await execFileAsync("git", ["-C", workspace, "commit", "-q", "-m", "base"], { env: environment });
  if (options.rehydrate !== true) return;

  // `git add` never rewrites the worktree, so a repository declaring eol=crlf
  // still holds LF until the files are checked out again. Real runs always see
  // the checked-out form, so the fixture must reproduce it.
  for (const relative of splitNul(await git(workspace, ["ls-files", "-z"]))) {
    await rm(path.join(workspace, relative), { force: true });
  }
  await execFileAsync("git", ["-C", workspace, "checkout", "-q", "--", "."], { env: environment });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Gardener Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Gardener Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

async function git(cwd: string, argv: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...argv], { env: gitEnvironment(), maxBuffer: 16 * 1_024 * 1_024 });
  return stdout;
}

async function headSha(workspace: string): Promise<string> {
  return (await git(workspace, ["rev-parse", "HEAD"])).trim();
}

/**
 * Loose objects under `.git/objects`, the instrument for proving that a
 * refusal happened before `hash-object -w` rather than after it. No other
 * command capture runs writes to the object database.
 */
async function countLooseObjects(workspace: string): Promise<number> {
  const root = path.join(workspace, ".git", "objects");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
    total += (await readdir(path.join(root, entry.name))).length;
  }
  return total;
}

/**
 * Whether a hole-punched file is stored sparsely. The size-ceiling fixtures
 * declare multi-gigabyte files, which is only viable if the filesystem does
 * not materialize the zeroes.
 */
async function isSparse(target: string): Promise<boolean> {
  const stats = await stat(target);
  return stats.blocks * 512 < 1_024 * 1_024;
}

/** Runs `body` with `variables` applied to this process, restoring them after. */
async function withEnvironment(variables: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function temporaryDirectory(): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "gardener-capture-")));
  roots.push(directory);
  return directory;
}

function splitNul(value: string): string[] {
  return value.split("\u0000").filter((entry) => entry.length > 0);
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(typeof content === "string" ? Buffer.from(content, "utf8") : content).digest("hex");
}

/**
 * Independent re-derivation of the module's canonical encodings, so the forged
 * artifact is built the way capture builds a real one rather than by calling
 * the code under test.
 */
function framed(fields: readonly string[]): Buffer {
  return Buffer.concat(fields.map((field) => {
    const bytes = Buffer.from(field, "utf8");
    return Buffer.concat([Buffer.from(`${bytes.byteLength}:`, "utf8"), bytes]);
  }));
}

function fileRecord(file: TaskCaptureFileV1): Buffer {
  return file.status === "deleted"
    ? framed(["delete", file.path])
    : framed(["upsert", file.path, file.mode, String(file.sizeBytes), file.sha256]);
}

function changesStream(files: readonly TaskCaptureFileV1[]): Buffer {
  return Buffer.concat(files.map(fileRecord));
}

function identityStream(baseSha: string, files: readonly TaskCaptureFileV1[]): Buffer {
  return Buffer.concat([framed(["gardener.task-capture/v1", baseSha]), ...files.map(fileRecord)]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
