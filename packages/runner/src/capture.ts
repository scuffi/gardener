/**
 * Trusted working-tree capture.
 *
 * The model can run arbitrary shell through `repository.exec`, so nothing it
 * says about what it changed is trustworthy — and neither is anything it can
 * write. This module is the trusted half: it snapshots Git's authority state
 * before the model runs, and afterwards derives the change set itself, failing
 * closed whenever that authority has moved underneath it.
 *
 * Trust model:
 *
 * - the index, the effective Git configuration, `.git/info/exclude`, and every
 *   attributes file are digested *before* execution and re-verified at capture.
 *   The model shares a uid with this process, so it can rewrite all of them;
 *   detecting that and refusing is the only sound response, because a capture
 *   taken against model-chosen authority is a capture the model authored;
 * - classification and materialization both go through Git, so `.gitattributes`
 *   `text`/`eol` normalization and clean filters are applied exactly as they
 *   were at checkout. Hashing raw worktree bytes would report every file in a
 *   `text eol=crlf` repository as modified and would commit CRLF everywhere;
 * - a path whose attributes name a filter driver that the pinned configuration
 *   cannot resolve is refused rather than captured raw. This is the Git LFS
 *   case: the index holds a pointer, the worktree may hold the real object, and
 *   silently committing the object in place of the pointer would corrupt the
 *   repository;
 * - file bytes never pass through this module's return value and are never held
 *   whole in memory; they stream from Git to a private artifact file;
 * - the walk never follows directory symlinks and never leaves the workspace;
 * - `.git`, the runner's private HOME, and the contract's protected prefixes are
 *   never capturable, so a run cannot rewrite the authority governing the next
 *   run;
 * - ignored paths are decided by Git, not by this module.
 *
 * The artifact directory layout is part of the contract with the apply job:
 *
 *   <runnerTemp>/gardener-capture/<captureId>/manifest.json
 *   <runnerTemp>/gardener-capture/<captureId>/content/<sha256>
 *
 * That directory is untrusted runner-side state: it lives on a filesystem the
 * model can write. It is a transport, not a trust boundary. The binding that
 * matters is the {@link TaskCaptureRefV1} carried inside the plan through the
 * Gardener runtime, which is why {@link verifyCaptureArtifact} *requires* the
 * expected reference instead of re-deriving one from whatever is on disk.
 */

import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CAPTURE_FILE_MAX_BYTES,
  CAPTURE_TOTAL_MAX_BYTES,
  isProtectedCapturePath,
  taskCaptureChangesDigestInput,
  taskCaptureManifestText,
  taskCaptureManifestV1Schema,
  taskCaptureRefV1Schema,
  type TaskCaptureFileV1,
  type TaskCaptureManifestV1,
  type TaskCaptureRefV1,
} from "@gardener/contracts";

/** Git index mode for a submodule entry. Submodule contents are never capturable. */
const GITLINK_MODE = "160000";
const RUNNER_HOME_PATH = ".gardener/runner-home";
const RUNNER_HOME_PREFIX = `${RUNNER_HOME_PATH}/`;
const ATTRIBUTES_FILE = ".gitattributes";
const ARTIFACT_ROOT = "gardener-capture";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** Caps collected stdout so a hostile repository surfaces a readable error, not `ENOBUFS`. */
const GIT_MAX_OUTPUT = 64 * 1_024 * 1_024;
const MAX_PATH_LENGTH = 1_024;

/**
 * Configuration Git may not take from the environment during a capture.
 *
 * Global and system configuration are disabled because the model shares a uid
 * with this process and can write `~/.gitconfig`. `core.hooksPath` and
 * `core.fsmonitor` are forced inert on the command line, where no configuration
 * file can override them, so no repository state can make Git execute a program
 * of the model's choosing inside the trusted half.
 *
 * `core.attributesFile` and `core.excludesFile` are pinned for a subtler
 * reason. Both have *built-in default paths* — `$XDG_CONFIG_HOME/git/attributes`
 * and `.../ignore`, falling back to `$HOME/.config/git/...` — that live outside
 * any configuration file, so disabling global and system config does not
 * disable them, and `GIT_ATTR_NOSYSTEM` suppresses only the *system* attributes
 * file. `repository.exec` runs as the same uid and inherits the runner's real
 * HOME, so the model can create them. A planted `* text` would renormalize every
 * path: untouched files would hash differently from the index, be classified as
 * modified, and be materialized with rewritten line endings — and because the
 * attribute is `text` rather than `filter`, it would route around the
 * unresolvable-filter refusal entirely. A planted ignore file would meanwhile
 * subtract untracked paths from the change set. Neither file is covered by the
 * authority digests, so pinning both here is the only place the bypass closes.
 */
const GIT_PINNED_ARGV = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "protocol.allow=never",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.excludesFile=/dev/null",
] as const;

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

export type TaskCaptureFileModeV1 = "100644" | "100755" | "120000";

export interface WorkingTreeCaptureOptions {
  /** Absolute path of the checked-out Actions workspace. */
  workspace: string;
  /** Absolute path of `RUNNER_TEMP`; must resolve outside the workspace. */
  runnerTemp: string;
  /** Commit the planning job checked out. HEAD must match it exactly. */
  baseSha: string;
}

export interface CaptureRequest {
  /**
   * Repository-relative POSIX paths limiting the capture. A filter matches an
   * exact path or any path beneath it. Omit to capture the whole tree.
   */
  paths?: readonly string[];
  /**
   * Optional ceiling on captured content bytes, narrowing the contract's own
   * ceilings rather than replacing them.
   *
   * Omitting it does not mean unbounded: {@link CAPTURE_FILE_MAX_BYTES} and
   * {@link CAPTURE_TOTAL_MAX_BYTES} always apply, because a capture larger than
   * those could never be applied through the Git Data API. What the contract
   * deliberately does not cap is the file *count*, since a number invented
   * there would break a legitimate refactor.
   */
  maxBytes?: number;
  /** Optional ceiling on captured entries, enforced as entries are classified. */
  maxFiles?: number;
}

export type CaptureResult =
  | { status: "unchanged" }
  | {
    status: "captured";
    ref: TaskCaptureRefV1;
    manifest: TaskCaptureManifestV1;
    /** Absolute path of the private artifact directory. Untrusted transport. */
    directory: string;
  };

interface IndexEntry {
  mode: string;
  blobSha: string;
}

interface WalkedEntry {
  kind: "file" | "symlink" | "special";
  absolute: string;
  /** Owner-executable bit; only meaningful for regular files. */
  executable: boolean;
}

/**
 * Byte ceilings applied to one capture.
 *
 * The provider's limits and the caller's optional `maxBytes` are folded into a
 * single pair so every enforcement point applies all of them, and so a capture
 * is bounded even when the task declares no ceiling of its own. `maxBytes` is
 * carried alongside so a violation can name the number the caller chose rather
 * than a derived one.
 */
interface CaptureBudget {
  perFile: number;
  total: number;
  maxBytes: number | undefined;
}

/**
 * Effective configuration under the pinned environment.
 *
 * The digest is taken over Git's raw `--show-origin --null --list` bytes rather
 * than a reconstructed map. Multi-valued keys — `include.path`,
 * `remote.*.fetch`, `http.*.extraHeader` — are real, and a map keeps only the
 * last value, so two configurations Git treats differently would digest
 * identically. Origins are included, so moving a key between the repository
 * config and an included file is a change too. The parsed values are kept only
 * to answer whether a named filter driver is runnable.
 */
interface GitConfigSnapshot {
  digest: string;
  values: ReadonlyMap<string, string>;
  /** Raw origin+record pairs, preserving order and duplicate keys. */
  records: readonly string[];
}

/**
 * Digests of everything that decides how Git interprets the working tree.
 *
 * Taken before execution and compared afterwards. A change here is not a
 * capture failure mode to be worked around — it means the model redefined what
 * "changed" means, and the run must stop.
 */
interface GitAuthority {
  index: ReadonlyMap<string, IndexEntry>;
  indexDigest: string;
  config: GitConfigSnapshot;
  excludeDigest: string;
  attributeDigests: ReadonlyMap<string, string>;
}

interface ChangedFile {
  path: string;
  status: "added" | "modified";
  mode: TaskCaptureFileModeV1;
  /** Git blob id of the canonical content, or `undefined` for a symlink. */
  blobSha?: string;
  /** Symlink target bytes, materialized directly rather than through Git. */
  linkTarget?: Buffer;
}

/**
 * The present-file arm of the contract's capture union, derived from it rather
 * than restated so a contract change cannot silently diverge from what this
 * module writes into the manifest.
 */
type MaterializedFile = Extract<TaskCaptureFileV1, { status: "added" | "modified" }>;

/**
 * Snapshots Git's authority before model execution and derives the change set
 * after.
 *
 * Construct through {@link WorkingTreeCapture.initialize}, which performs the
 * pre-execution snapshot; capturing without it cannot tell an added file from
 * one that was always tracked, nor a model-rewritten index from the real one.
 */
export class WorkingTreeCapture {
  readonly #workspace: string;
  readonly #artifactRoot: string;
  readonly #baseSha: string;
  readonly #authority: GitAuthority;
  readonly #submodules: readonly string[];

  private constructor(
    workspace: string,
    artifactRoot: string,
    baseSha: string,
    authority: GitAuthority,
    submodules: readonly string[],
  ) {
    this.#workspace = workspace;
    this.#artifactRoot = artifactRoot;
    this.#baseSha = baseSha;
    this.#authority = authority;
    this.#submodules = submodules;
  }

  /** Commit this capture is bound to. */
  get baseSha(): string {
    return this.#baseSha;
  }

  /**
   * Records the pre-execution snapshot. Run this before the model is allowed to
   * execute anything, and never afterwards.
   */
  static async initialize(options: WorkingTreeCaptureOptions): Promise<WorkingTreeCapture> {
    const baseSha = normalizeSha1(options.baseSha, "base commit");
    if (!(await directoryExists(options.workspace))) throw new Error("Capture workspace does not exist");
    if (!(await directoryExists(options.runnerTemp))) throw new Error("Capture runner temp directory does not exist");

    // Resolved through realpath so a symlinked RUNNER_TEMP cannot smuggle the
    // artifact root back inside the workspace, where the next capture would
    // read its own output.
    const workspace = await realpath(path.resolve(options.workspace));
    const runnerTemp = await realpath(path.resolve(options.runnerTemp));
    if (runnerTemp === workspace || contains(workspace, runnerTemp)) {
      throw new Error("Capture artifacts must not be written inside the workspace");
    }

    const head = normalizeSha1(await gitText(workspace, ["rev-parse", "HEAD"]), "HEAD");
    if (head !== baseSha) throw new Error(`Workspace HEAD ${head} does not match the expected base commit ${baseSha}`);

    const { index, submodules, digest } = await readIndex(workspace);
    const authority: GitAuthority = {
      index,
      indexDigest: digest,
      config: await readConfig(workspace),
      excludeDigest: await fileDigest(path.join(workspace, ".git", "info", "exclude")),
      attributeDigests: await readAttributeDigests(workspace, [...index.keys()]),
    };
    return new WorkingTreeCapture(workspace, path.join(runnerTemp, ARTIFACT_ROOT), baseSha, authority, submodules);
  }

  /**
   * Derives the change set from the current working tree and writes the private
   * artifact. Repeating a capture over an identical tree is idempotent.
   */
  async capture(request: CaptureRequest = {}): Promise<CaptureResult> {
    const filters = normalizeFilters(request.paths);
    const maxBytes = optionalLimit(request.maxBytes, "maxBytes");
    const maxFiles = optionalLimit(request.maxFiles, "maxFiles");

    const head = normalizeSha1(await gitText(this.#workspace, ["rev-parse", "HEAD"]), "HEAD");
    if (head !== this.#baseSha) {
      throw new Error(`Workspace HEAD moved to ${head} during execution; the capture base is no longer valid`);
    }

    const walked = new Map<string, WalkedEntry>();
    await this.#walk(this.#workspace, "", walked);
    await this.#assertAuthorityUnchanged(walked);
    await this.#assertSubmodulesUnchanged();

    const untracked = new Set<string>();
    for (const entry of splitNul(await gitText(this.#workspace, ["ls-files", "-z", "--others", "--exclude-standard"]))) {
      assertCapturablePath(entry);
      untracked.add(entry);
    }

    const candidates = [...new Set([...this.#authority.index.keys(), ...untracked])]
      .filter((entry) => matchesFilters(entry, filters))
      .sort(byPath);

    const budget = captureBudget(maxBytes);
    const { deletions, changed } = await this.#classify(candidates, walked, maxFiles, budget);
    if (deletions.length + changed.length === 0) return { status: "unchanged" };
    await this.#assertChangeWithinBudget(changed, walked, budget);
    // Classification invokes Git clean filters. Re-read every authority input
    // afterwards so a concurrent command cannot change .gitattributes/config
    // between the first check and blob materialization.
    await this.#assertFreshAuthority();

    const staging = await this.#prepareArtifactDirectory();
    let totalBytes = 0;
    const materialized: MaterializedFile[] = [];
    try {
      // One batched write puts every filtered blob in the object database, so
      // materialization is a stream per file rather than a process per file.
      const blobPaths = changed.filter((file) => file.linkTarget === undefined).map((file) => file.path);
      if (blobPaths.length > 0) {
        await gitText(this.#workspace, ["hash-object", "-w", "--stdin-paths"], { input: `${blobPaths.join("\n")}\n` });
      }
      for (const file of changed) {
        const written = await this.#materialize(staging, file, budget, totalBytes);
        totalBytes += written.sizeBytes;
        materialized.push(written);
      }
      // A daemonized child could outlive its shell command. This final check
      // closes the interval in which authority changed while blobs streamed;
      // changes after it cannot influence bytes already materialized.
      await this.#assertFreshAuthority();

      const files: TaskCaptureFileV1[] = [...deletions, ...materialized]
        .sort((left, right) => byPath(left.path, right.path));
      const captureId = `cap_${sha256Hex(identityStream(this.#baseSha, files))}`;
      const manifest = parseManifest({
        schemaVersion: "gardener.task-capture-manifest/v1",
        captureId,
        baseSha: this.#baseSha,
        files,
        totalBytes,
        truncated: false,
      });
      const manifestBytes = Buffer.from(taskCaptureManifestText(manifest), "utf8");
      const target = path.join(this.#artifactRoot, captureId);
      const content = path.join(target, "content");
      await mkdir(content, { recursive: true, mode: DIRECTORY_MODE });
      for (const entry of await readdir(path.join(staging, "content"))) {
        await rename(path.join(staging, "content", entry), path.join(content, entry));
      }
      await atomicWrite(path.join(target, "manifest.json"), manifestBytes);
      await rm(staging, { recursive: true, force: true });
      await hardenDirectories([this.#artifactRoot, target, content]);

      const ref = taskCaptureRefV1Schema.parse({
        schemaVersion: "gardener.task-capture-ref/v1",
        captureId,
        baseSha: this.#baseSha,
        manifestSha256: sha256Hex(manifestBytes),
        changesSha256: sha256Hex(changesStream(manifest)),
        fileCount: files.length,
        sizeBytes: totalBytes,
      });
      return { status: "captured", ref, manifest, directory: target };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Refuses to proceed when anything that defines "changed" moved after the
   * pre-execution snapshot: staged entries, effective configuration, the
   * private exclude file, or any attributes file — including one the model
   * newly created, which would otherwise introduce a filter this module would
   * then execute.
   */
  async #assertFreshAuthority(): Promise<void> {
    const walked = new Map<string, WalkedEntry>();
    await this.#walk(this.#workspace, "", walked);
    await this.#assertAuthorityUnchanged(walked);
  }

  async #assertAuthorityUnchanged(walked: ReadonlyMap<string, WalkedEntry>): Promise<void> {
    const current = await readIndex(this.#workspace);
    if (current.digest !== this.#authority.indexDigest) {
      throw new Error("Git index changed during execution; stage nothing and let Gardener capture the working tree");
    }
    const config = await readConfig(this.#workspace);
    if (config.digest !== this.#authority.config.digest && !onlyLfsRepositoryFormatInitialization(this.#authority.config, config)) {
      throw new Error("Git configuration changed during execution; capture refuses model-supplied Git configuration");
    }
    if (await fileDigest(path.join(this.#workspace, ".git", "info", "exclude")) !== this.#authority.excludeDigest) {
      throw new Error("Git exclude rules changed during execution; capture refuses model-supplied exclude rules");
    }
    const attributePaths = new Set<string>(this.#authority.attributeDigests.keys());
    for (const entry of walked.keys()) {
      if (entry === ATTRIBUTES_FILE || entry.endsWith(`/${ATTRIBUTES_FILE}`)) attributePaths.add(entry);
    }
    const currentAttributes = await readAttributeDigests(this.#workspace, [...attributePaths]);
    for (const attributePath of attributePaths) {
      if (currentAttributes.get(attributePath) !== this.#authority.attributeDigests.get(attributePath)) {
        throw new Error(`Git attributes changed during execution (${attributePath}); capture refuses model-supplied filters`);
      }
    }
  }

  /**
   * A gitlink is a pointer into another repository, so its contents cannot be
   * expressed in this manifest.
   *
   * `actions/checkout` does not initialize submodules by default, which Git
   * reports with a `-` prefix. That is the normal state and must capture
   * cleanly. A moved (`+`) or conflicted (`U`) gitlink, or a dirty initialized
   * worktree, means work the model believes it did would be silently dropped.
   *
   * A gitlink with no `.gitmodules` mapping — the shape `git add` produces from
   * an accidentally embedded repository, and the shape a deleted `.gitmodules`
   * leaves behind — makes `git submodule status` exit 128 with nothing to
   * parse. Letting that error escape would make every capture in such a
   * repository fail on an unactionable git message, so this decides the same
   * question directly from the worktree instead of treating the failure as
   * either fatal or safe.
   */
  async #assertSubmodulesUnchanged(): Promise<void> {
    for (const submodule of this.#submodules) {
      const absolute = path.join(this.#workspace, submodule);
      const status = await gitText(this.#workspace, ["submodule", "status", "--", submodule], { trim: false })
        .catch(() => undefined);
      if (status === undefined) {
        // Git models nothing for an unmapped gitlink, so the worktree is the
        // only evidence. Absent or empty is exactly what a fresh checkout
        // leaves and carries no work to drop; anything populated is a nested
        // repository whose state cannot be compared against the recorded
        // commit, and is refused rather than silently ignored.
        if (await isAbsentOrEmptyDirectory(absolute)) continue;
        throw new Error(
          `Cannot capture ${submodule}: it is a Git submodule (gitlink) with no .gitmodules mapping and a populated worktree, so Gardener cannot prove it is unchanged`,
        );
      }
      const marker = status.charAt(0);
      if (marker === "-") continue;
      if (marker !== " ") {
        throw new Error(`Cannot capture ${submodule}: submodule changes are not capturable`);
      }
      const worktree = await gitText(absolute, ["status", "--porcelain", "-z"]);
      if (worktree.length > 0) {
        throw new Error(`Cannot capture ${submodule}: submodule changes are not capturable`);
      }
    }
  }

  /**
   * Refuses an oversized change before `hash-object -w` reads or stores a byte.
   *
   * Sizes come from `lstat`, which never follows the path's final component, so
   * a symlink planted over a candidate cannot redirect the measurement. These
   * are worktree sizes, so they are an estimate of what Git will finally store
   * — a clean filter may shrink or expand them — which is why the streaming
   * meter in {@link WorkingTreeCapture.#materialize} remains authoritative. The
   * point of measuring here is that the object database and the artifact are
   * never written for input already known to be too large.
   */
  async #assertChangeWithinBudget(
    files: readonly ChangedFile[],
    walked: ReadonlyMap<string, WalkedEntry>,
    budget: CaptureBudget,
  ): Promise<void> {
    let declared = 0;
    for (const file of files) {
      const bytes = file.linkTarget !== undefined
        ? file.linkTarget.byteLength
        : await worktreeSize(walked.get(file.path)?.absolute);
      if (bytes === undefined) continue;
      if (bytes > budget.perFile) throw budgetFailure(budget, budget.perFile, `Capture content for ${file.path}`);
      declared += bytes;
      if (declared > budget.total) throw budgetFailure(budget, budget.total, "Capture");
    }
  }

  /**
   * Refuses an oversized *untracked* candidate before classification hashes it.
   *
   * An untracked path belongs to the change set whatever it hashes to, so its
   * size is decidable without reading it. A tracked path is different: only its
   * blob id says whether it changed at all, so it has to be hashed — a read
   * that stores nothing, with the object database still gated behind
   * {@link WorkingTreeCapture.#assertChangeWithinBudget}.
   */
  async #assertUntrackedWithinBudget(
    candidates: readonly { path: string; entry: WalkedEntry }[],
    budget: CaptureBudget,
  ): Promise<void> {
    let declared = 0;
    for (const candidate of candidates) {
      if (this.#authority.index.has(candidate.path)) continue;
      const bytes = await worktreeSize(candidate.entry.absolute);
      if (bytes === undefined) continue;
      if (bytes > budget.perFile) throw budgetFailure(budget, budget.perFile, `Capture content for ${candidate.path}`);
      declared += bytes;
      if (declared > budget.total) throw budgetFailure(budget, budget.total, "Capture");
    }
  }

  /**
   * Splits candidates into deletions and changed entries.
   *
   * Classification asks Git for each present file's blob id so that `text`,
   * `eol`, and clean-filter semantics decide equality. Comparing raw bytes
   * against the index would mark every normalized file modified.
   */
  async #classify(
    candidates: readonly string[],
    walked: ReadonlyMap<string, WalkedEntry>,
    maxFiles: number | undefined,
    budget: CaptureBudget,
  ): Promise<{ deletions: TaskCaptureFileV1[]; changed: ChangedFile[] }> {
    const deletions: TaskCaptureFileV1[] = [];
    const present: { path: string; entry: WalkedEntry; mode: TaskCaptureFileModeV1 }[] = [];

    for (const entry of candidates) {
      this.#assertNotSubmodule(entry);
      const walkedEntry = walked.get(entry);
      const indexed = this.#authority.index.get(entry);
      if (walkedEntry === undefined) {
        if (indexed === undefined) continue;
        assertCapturableTarget(entry);
        deletions.push({ path: entry, status: "deleted" });
        continue;
      }
      if (walkedEntry.kind === "special") {
        throw new Error(`Cannot capture ${entry}: only regular files and symbolic links are capturable`);
      }
      present.push({
        path: entry,
        entry: walkedEntry,
        mode: walkedEntry.kind === "symlink" ? "120000" : walkedEntry.executable ? "100755" : "100644",
      });
    }

    const regular = present.filter((candidate) => candidate.entry.kind === "file");
    await this.#assertUntrackedWithinBudget(regular, budget);
    const blobShas = await this.#hashCandidates(regular.map((candidate) => candidate.path));
    const filters = await this.#readFilterAttributes(regular.map((candidate) => candidate.path));

    const changed: ChangedFile[] = [];
    for (const candidate of present) {
      const indexed = this.#authority.index.get(candidate.path);
      if (candidate.entry.kind === "symlink") {
        const target = Buffer.from(await readlink(candidate.entry.absolute), "utf8");
        const blobSha = gitBlobSha1(target);
        if (indexed !== undefined && indexed.mode === "120000" && indexed.blobSha === blobSha) continue;
        assertCapturableTarget(candidate.path);
        changed.push({ path: candidate.path, status: indexed === undefined ? "added" : "modified", mode: "120000", linkTarget: target });
        continue;
      }
      const blobSha = blobShas.get(candidate.path);
      if (blobSha === undefined) throw new Error(`Git did not report a blob id for ${candidate.path}`);
      if (indexed !== undefined && indexed.mode === candidate.mode && indexed.blobSha === blobSha) continue;

      // Reached only for a path Git reports as different. If its attributes name
      // a filter the pinned configuration cannot run, that difference may be the
      // missing filter rather than the model's work — committing the unfiltered
      // bytes would replace an LFS pointer with the object it points at.
      const driver = filters.get(candidate.path);
      if (driver !== undefined && !this.#hasFilterDriver(driver)) {
        throw new Error(
          `Cannot capture ${candidate.path}: it uses the Git filter '${driver}', which is not available under Gardener's pinned Git configuration`,
        );
      }
      assertCapturableTarget(candidate.path);
      changed.push({ path: candidate.path, status: indexed === undefined ? "added" : "modified", mode: candidate.mode, blobSha });
    }

    const total = deletions.length + changed.length;
    if (maxFiles !== undefined && total > maxFiles) throw new Error(`Capture exceeds maxFiles=${maxFiles}`);
    return { deletions, changed };
  }

  /** Batch `hash-object`, which applies the pinned attributes to every path. */
  async #hashCandidates(paths: readonly string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (paths.length === 0) return result;
    const output = await gitText(this.#workspace, ["hash-object", "--stdin-paths"], { input: `${paths.join("\n")}\n` });
    const lines = output.split("\n").filter((line) => line.length > 0);
    if (lines.length !== paths.length) throw new Error("Git reported an unexpected number of object ids");
    paths.forEach((entry, position) => result.set(entry, normalizeSha1(lines[position] as string, "worktree blob")));
    return result;
  }

  /** Named clean/smudge drivers declared for each path by the pinned attributes. */
  async #readFilterAttributes(paths: readonly string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (paths.length === 0) return result;
    const output = await gitText(this.#workspace, ["check-attr", "-z", "--stdin", "filter"], {
      input: `${paths.join("\u0000")}\u0000`,
      trim: false,
    });
    const fields = output.split("\u0000");
    for (let index = 0; index + 2 < fields.length; index += 3) {
      const value = fields[index + 2] as string;
      if (value === "unspecified" || value === "unset" || value === "set" || value === "") continue;
      result.set(fields[index] as string, value);
    }
    return result;
  }

  #hasFilterDriver(driver: string): boolean {
    const { values } = this.#authority.config;
    return values.has(`filter.${driver}.clean`) || values.has(`filter.${driver}.process`);
  }

  #assertNotSubmodule(entry: string): void {
    for (const submodule of this.#submodules) {
      if (entry === submodule || entry.startsWith(`${submodule}/`)) {
        throw new Error(`Cannot capture ${entry}: submodule changes are not capturable`);
      }
    }
  }

  /** Private staging directory; content lands here before the capture id exists. */
  async #prepareArtifactDirectory(): Promise<string> {
    const staging = path.join(this.#artifactRoot, `staging-${process.pid}-${uniqueSuffix()}`);
    await mkdir(path.join(staging, "content"), { recursive: true, mode: DIRECTORY_MODE });
    await hardenDirectories([this.#artifactRoot, staging, path.join(staging, "content")]);
    return staging;
  }

  /**
   * Streams one file's canonical bytes into the artifact.
   *
   * Content never exists whole in memory: the batched `hash-object -w` has
   * already stored the filtered blob in the workspace object database, and its
   * bytes flow from `cat-file` through a hashing meter straight to disk. The
   * meter is the authoritative ceiling rather than a second opinion: the
   * pre-write check in {@link WorkingTreeCapture.#assertChangeWithinBudget}
   * measures the *worktree*, and a clean filter may expand what Git finally
   * stores, so only the canonical byte count can be trusted. Exceeding it
   * abandons the stream part-written, and the staging directory is removed by
   * the caller.
   */
  async #materialize(
    directory: string,
    file: ChangedFile,
    budget: CaptureBudget,
    capturedBytes: number,
  ): Promise<MaterializedFile> {
    const temporary = path.join(directory, "content", `.tmp-${process.pid}-${uniqueSuffix()}`);
    const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, FILE_MODE);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.byteLength;
        if (!Number.isSafeInteger(sizeBytes)) {
          callback(new Error(`Capture content for ${file.path} exceeds the safe integer range`));
          return;
        }
        if (sizeBytes > budget.perFile) {
          callback(budgetFailure(budget, budget.perFile, `Capture content for ${file.path}`));
          return;
        }
        if (capturedBytes + sizeBytes > budget.total) {
          callback(budgetFailure(budget, budget.total, "Capture"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      if (file.linkTarget !== undefined) {
        const target = file.linkTarget;
        await pipeline(async function* () { yield target; }, meter, fileHandleSink(handle));
      } else {
        // `cat-file` streams exactly the canonical, filter-applied bytes the Git
        // Data API should commit — never the raw worktree bytes.
        await gitStream(this.#workspace, ["cat-file", "blob", file.blobSha as string], meter, fileHandleSink(handle));
      }
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }

    const sha256 = hash.digest("hex");
    await rename(temporary, path.join(directory, "content", sha256));
    return { path: file.path, status: file.status, mode: file.mode, sizeBytes, sha256 };
  }

  async #walk(absolute: string, relative: string, output: Map<string, WalkedEntry>): Promise<void> {
    const entries = (await readdir(absolute, { withFileTypes: true }))
      .sort((left, right) => byPath(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (childRelative === RUNNER_HOME_PATH) continue;
      const childAbsolute = path.join(absolute, entry.name);
      if (entry.isSymbolicLink()) {
        output.set(childRelative, { kind: "symlink", absolute: childAbsolute, executable: false });
        continue;
      }
      if (entry.isDirectory()) {
        await this.#walk(childAbsolute, childRelative, output);
        continue;
      }
      if (!entry.isFile()) {
        output.set(childRelative, { kind: "special", absolute: childAbsolute, executable: false });
        continue;
      }
      const stats = await lstat(childAbsolute).catch(() => undefined);
      if (stats === undefined) continue;
      output.set(childRelative, { kind: "file", absolute: childAbsolute, executable: (stats.mode & 0o100) !== 0 });
    }
  }
}

/**
 * Folds the provider's ceilings together with the caller's optional `maxBytes`.
 *
 * `CAPTURE_FILE_MAX_BYTES` is the largest blob the Git Data API accepts and
 * `CAPTURE_TOTAL_MAX_BYTES` the largest capture a commit could materialize, so
 * a capture beyond either could never be applied. Enforcing them here rather
 * than only in the manifest schema means such input is refused before it is
 * read into the object database, not after.
 */
function captureBudget(maxBytes: number | undefined): CaptureBudget {
  const total = Math.min(maxBytes ?? CAPTURE_TOTAL_MAX_BYTES, CAPTURE_TOTAL_MAX_BYTES);
  return { perFile: Math.min(total, CAPTURE_FILE_MAX_BYTES), total, maxBytes };
}

/** Names the caller's own ceiling when that is the one exceeded, not a derived number. */
function budgetFailure(budget: CaptureBudget, limit: number, subject: string): Error {
  return budget.maxBytes !== undefined && limit === budget.maxBytes
    ? new Error(`Capture exceeds maxBytes=${budget.maxBytes}`)
    : new Error(`${subject} exceeds the ${limit}-byte capture ceiling`);
}

/** Size of a path's own inode, never a symlink target's, or `undefined` if it vanished. */
async function worktreeSize(absolute: string | undefined): Promise<number | undefined> {
  if (absolute === undefined) return undefined;
  const stats = await lstat(absolute).catch(() => undefined);
  return stats?.isFile() === true ? stats.size : undefined;
}

/** True when a gitlink's worktree holds nothing, which is what a fresh checkout leaves. */
async function isAbsentOrEmptyDirectory(absolute: string): Promise<boolean> {
  const stats = await lstat(absolute).catch(() => undefined);
  if (stats === undefined) return true;
  if (!stats.isDirectory()) return false;
  const entries = await readdir(absolute).catch(() => undefined);
  return entries?.length === 0;
}

/**
 * Proves an artifact directory still holds exactly the capture a plan is bound
 * to.
 *
 * The expected reference is required, and that is the whole point: the
 * directory is runner-side state the model can rewrite after `capture()`
 * returns, so a manifest and its blobs edited *together* are internally
 * consistent and must still be rejected. Only the reference carried inside the
 * plan — through the Gardener runtime, out of the model's reach — can say what
 * planning actually captured. Apply must pass that immutable plan-bound
 * reference, never one re-read from disk.
 *
 * Directory permissions are not part of this: `repository.exec` runs as the
 * same uid on the same runner, so `0700` is hygiene, not a control.
 */
export async function verifyCaptureArtifact(
  directory: string,
  expected: TaskCaptureRefV1,
): Promise<{ ref: TaskCaptureRefV1; manifest: TaskCaptureManifestV1 }> {
  const reference = taskCaptureRefV1Schema.parse(expected);
  const manifestBytes = await readBoundedFile(path.join(directory, "manifest.json"), GIT_MAX_OUTPUT);
  const manifestSha256 = sha256Hex(manifestBytes);
  if (!equalsConstantTime(manifestSha256, reference.manifestSha256)) {
    throw new Error("Capture manifest digest mismatch");
  }

  const manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  if (taskCaptureManifestText(manifest) !== manifestBytes.toString("utf8")) throw new Error("Capture manifest is not canonical");

  const totalBytes = manifest.files.reduce((total, file) => total + (file.status === "deleted" ? 0 : file.sizeBytes), 0);
  const expectations: readonly [string, string, string][] = [
    ["capture id", manifest.captureId, reference.captureId],
    ["base commit", manifest.baseSha, reference.baseSha],
    ["file count", String(manifest.files.length), String(reference.fileCount)],
    ["size", String(totalBytes), String(reference.sizeBytes)],
    ["changes digest", sha256Hex(changesStream(manifest)), reference.changesSha256],
    ["capture id derivation", `cap_${sha256Hex(identityStream(manifest.baseSha, manifest.files))}`, reference.captureId],
  ];
  for (const [label, actual, want] of expectations) {
    if (!equalsConstantTime(actual, want)) throw new Error(`Capture ${label} mismatch`);
  }

  for (const file of manifest.files) {
    if (file.status === "deleted") continue;
    const measured = await measureContent(path.join(directory, "content", file.sha256), file.sizeBytes);
    if (measured === undefined) throw new Error(`Captured content size mismatch for ${file.path}`);
    if (!equalsConstantTime(measured, file.sha256)) throw new Error(`Captured content digest mismatch for ${file.path}`);
  }
  return { ref: reference, manifest };
}

/**
 * Canonical changes stream.
 *
 * Every field is length-prefixed, so no path — whatever bytes the contract's
 * `relativePath` admits — can be confused with a record boundary. Each upsert
 * record carries the SHA-256 of that path's bytes, so this single digest fixes
 * the entire changes artifact: the file names in the directory are irrelevant,
 * only the bytes they must hash to.
 */
function changesStream(manifest: TaskCaptureManifestV1): Buffer {
  return Buffer.from(taskCaptureChangesDigestInput(manifest));
}

/** Capture identity input: the base commit followed by the canonical changes stream. */
function identityStream(baseSha: string, files: readonly TaskCaptureFileV1[]): Buffer {
  return Buffer.concat([framed(["gardener.task-capture/v1", baseSha]), ...files.map(fileRecord)]);
}

/**
 * The one definition of a per-file record, shared by both digest streams so the
 * capture identity and the changes digest cannot drift apart.
 */
function fileRecord(file: TaskCaptureFileV1): Buffer {
  return file.status === "deleted"
    ? framed(["delete", file.path])
    : framed(["upsert", file.path, file.mode, String(file.sizeBytes), file.sha256]);
}

/** `<byteLength>:<bytes>` per field, so concatenation is injective. */
function framed(fields: readonly string[]): Buffer {
  return Buffer.concat(fields.map((field) => {
    const bytes = Buffer.from(field, "utf8");
    return Buffer.concat([Buffer.from(`${bytes.byteLength}:`, "utf8"), bytes]);
  }));
}

function parseManifest(value: unknown): TaskCaptureManifestV1 {
  const parsed = taskCaptureManifestV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join("/") || "manifest"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Capture manifest is invalid: ${detail}`);
}

/* -------------------------------------------------------------------------- */
/* Git                                                                        */
/* -------------------------------------------------------------------------- */

function runGit(
  cwd: string,
  argv: readonly string[],
  input: string | undefined,
  onStdout: ((chunk: Buffer) => void) | undefined,
  stdoutPipe?: { meter: Transform; sink: NodeJS.WritableStream },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...GIT_PINNED_ARGV, ...argv], {
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let failure: Error | undefined;
    let pending: Promise<void> | undefined;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const fail = (error: Error): void => {
      failure ??= error;
      child.kill("SIGKILL");
    };

    if (stdoutPipe !== undefined) {
      pending = pipeline(child.stdout, stdoutPipe.meter, stdoutPipe.sink).catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    } else if (onStdout !== undefined) {
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          onStdout(chunk);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } else {
      child.stdout.resume();
    }

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 4_096) return;
      stderrBytes += chunk.byteLength;
      stderr.push(chunk);
    });
    child.on("error", (error) => fail(error));
    child.on("close", (code, signal) => {
      void Promise.resolve(pending).then(() => {
        if (failure !== undefined) {
          reject(failure);
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const detail = Buffer.concat(stderr).toString("utf8").trim().split("\n")[0] ?? "";
        reject(new Error(`git ${argv[0] ?? ""} failed (${code ?? signal}): ${detail}`.trim()));
      });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

/** Collected stdout as raw bytes, for callers that must digest exactly what Git wrote. */
async function gitBuffer(
  cwd: string,
  argv: readonly string[],
  options: { input?: string } = {},
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  await runGit(cwd, argv, options.input, (chunk) => {
    size += chunk.byteLength;
    if (size > GIT_MAX_OUTPUT) throw new Error(`git ${argv[0] ?? ""} produced more than ${GIT_MAX_OUTPUT} bytes`);
    chunks.push(chunk);
  });
  return Buffer.concat(chunks);
}

async function gitText(
  cwd: string,
  argv: readonly string[],
  options: { input?: string; trim?: boolean } = {},
): Promise<string> {
  const output = (await gitBuffer(cwd, argv, options)).toString("utf8");
  return options.trim === false ? output : output.trim();
}

async function gitStream(
  cwd: string,
  argv: readonly string[],
  meter: Transform,
  sink: NodeJS.WritableStream,
): Promise<void> {
  await runGit(cwd, argv, undefined, undefined, { meter, sink });
}

async function readIndex(workspace: string): Promise<{
  index: Map<string, IndexEntry>;
  submodules: string[];
  digest: string;
}> {
  const index = new Map<string, IndexEntry>();
  const submodules: string[] = [];
  const records: string[] = [];
  for (const record of splitNul(await gitText(workspace, ["ls-files", "-s", "-z"], { trim: false }))) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("Unreadable Git index entry");
    const [mode, blobSha, stage] = record.slice(0, separator).split(" ");
    const entry = record.slice(separator + 1);
    if (mode === undefined || blobSha === undefined || stage === undefined) throw new Error("Unreadable Git index entry");
    if (stage !== "0") throw new Error(`Workspace has an unmerged path: ${entry}`);
    assertCapturablePath(entry);
    records.push(`${mode} ${blobSha} ${entry}`);
    if (mode === GITLINK_MODE) {
      submodules.push(entry);
      continue;
    }
    if (entry === RUNNER_HOME_PATH || entry.startsWith(RUNNER_HOME_PREFIX)) {
      throw new Error(`Repository tracks a reserved Gardener runner path: ${entry}`);
    }
    index.set(entry, { mode, blobSha: normalizeSha1(blobSha, "index blob") });
  }
  return { index, submodules, digest: sha256Hex(framed(records)) };
}

/**
 * Effective configuration under the pinned environment, which is local
 * configuration plus the pinned command line. Global and system files are
 * already disabled, so this is exactly the state the model could reach.
 *
 * The digest is taken over Git's raw output. Reconstructing it from a parsed
 * map would drop every duplicate of a multi-valued key and impose an ordering
 * Git does not use, so a configuration the model rewrote could digest the same
 * as the one that was snapshotted. Origins are part of the output and so part
 * of the digest, which also covers a key moving between files.
 *
 * Each record is `origin\0key\nvalue\0`. Parsing keeps the last value per key,
 * which is all {@link WorkingTreeCapture.#hasFilterDriver} needs to decide
 * whether a named driver is runnable; equality is never decided from this map.
 */
function onlyLfsRepositoryFormatInitialization(before: GitConfigSnapshot, after: GitConfigSnapshot): boolean {
  // git-lfs lazily writes this one key on its first clean-filter invocation.
  // Compare duplicate-preserving raw records, not a last-value-wins map: a
  // model must not be able to hide an extra setting before an existing key.
  const clean = before.values.get("filter.lfs.clean") ?? "";
  if (!/^git-lfs(?:\s|$)/.test(clean) || before.values.has("lfs.repositoryformatversion")) return false;
  if (after.values.get("lfs.repositoryformatversion") !== "0") return false;
  if (after.records.length !== before.records.length + 1) return false;

  const remaining = [...after.records];
  for (const record of before.records) {
    const index = remaining.indexOf(record);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  if (remaining.length !== 1) return false;
  const [, added = ""] = remaining[0]!.split("\u0000", 2);
  const separator = added.indexOf("\n");
  const key = separator < 0 ? added : added.slice(0, separator);
  const value = separator < 0 ? "" : added.slice(separator + 1);
  return key === "lfs.repositoryformatversion" && value === "0";
}

async function readConfig(workspace: string): Promise<GitConfigSnapshot> {
  const raw = await gitBuffer(workspace, ["config", "--null", "--list", "--show-origin"]);
  const fields = raw.toString("utf8").split("\u0000");
  const values = new Map<string, string>();
  const records: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const origin = fields[index] as string;
    const record = fields[index + 1] as string;
    if (!origin && !record) continue;
    records.push(`${origin}\u0000${record}`);
    const separator = record.indexOf("\n");
    values.set(separator < 0 ? record : record.slice(0, separator), separator < 0 ? "" : record.slice(separator + 1));
  }
  return { digest: sha256Hex(raw), values, records };
}

/** Digests `.git/info/attributes` plus every `.gitattributes` in the given set. */
async function readAttributeDigests(
  workspace: string,
  candidates: readonly string[],
): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  digests.set(".git/info/attributes", await fileDigest(path.join(workspace, ".git", "info", "attributes")));
  for (const candidate of candidates) {
    if (candidate !== ATTRIBUTES_FILE && !candidate.endsWith(`/${ATTRIBUTES_FILE}`)) continue;
    digests.set(candidate, await fileDigest(path.join(workspace, candidate)));
  }
  return digests;
}

/* -------------------------------------------------------------------------- */
/* Filesystem                                                                 */
/* -------------------------------------------------------------------------- */

/** Digest of a file's bytes, or a sentinel when it does not exist. */
async function fileDigest(absolute: string): Promise<string> {
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => undefined);
  if (handle === undefined) return "absent";
  try {
    const hash = createHash("sha256");
    await pipeline(handle.createReadStream({ autoClose: false }), hash);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Reads a file that must not exceed `limit`, checking the size through the fd first. */
async function readBoundedFile(absolute: string, limit: number): Promise<Buffer> {
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`Capture artifact ${path.basename(absolute)} is not a regular file`);
    if (stats.size > limit) throw new Error(`Capture artifact ${path.basename(absolute)} exceeds ${limit} bytes`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Streams a content file and returns its digest, or `undefined` when its size
 * already disagrees. Size is read from the open descriptor before any bytes
 * are, so a blob inflated after capture is rejected rather than loaded.
 */
async function measureContent(absolute: string, expectedSize: number): Promise<string | undefined> {
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== expectedSize) return undefined;
    const hash = createHash("sha256");
    let seen = 0;
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          seen += chunk.byteLength;
          if (seen > expectedSize) {
            callback(new Error("Capture content grew while it was being verified"));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      async function* (source) { for await (const _chunk of source) { /* drained */ } },
    );
    return seen === expectedSize ? hash.digest("hex") : undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Streaming sink that appends to an already-open descriptor.
 *
 * `FileHandle.createWriteStream` cannot be used here. It takes an internal
 * reference on the handle and only releases it when the stream itself closes
 * the descriptor, so `{ autoClose: false }` — the only setting that leaves this
 * module in control of `sync()` and `close()` — makes `handle.close()` wait on
 * a reference that is never released. The handle then leaks until garbage
 * collection, which Node now reports as an error rather than a warning.
 * Writing through the handle directly keeps the stream bounded-memory without
 * taking that reference.
 */
function fileHandleSink(handle: Awaited<ReturnType<typeof open>>): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      handle.write(chunk).then(() => callback(), callback);
    },
  });
}

/**
 * Writes through a fresh descriptor that refuses to follow a symlink or reuse
 * an existing name, so a pre-planted temp file cannot redirect a trusted write.
 */
async function atomicWrite(target: string, content: Buffer): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${uniqueSuffix()}`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, FILE_MODE);
  try {
    await handle.writeFile(content);
    await handle.sync().catch(() => undefined);
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, target);
}

async function hardenDirectories(directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    await chmod(directory, DIRECTORY_MODE).catch(() => undefined);
  }
}

async function directoryExists(target: string): Promise<boolean> {
  const stats = await stat(target).catch(() => undefined);
  return stats?.isDirectory() ?? false;
}

function contains(parent: string, child: string): boolean {
  return child.startsWith(`${parent}${path.sep}`);
}

let counter = 0;

function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

/* -------------------------------------------------------------------------- */
/* Values                                                                     */
/* -------------------------------------------------------------------------- */

function splitNul(value: string): string[] {
  return value.split("\u0000").filter((entry) => entry.length > 0);
}

function gitBlobSha1(content: Buffer): string {
  return createHash("sha1")
    .update(Buffer.from(`blob ${content.byteLength}\u0000`, "utf8"))
    .update(content)
    .digest("hex");
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function equalsConstantTime(left: string, right: string): boolean {
  const first = Buffer.from(left, "utf8");
  const second = Buffer.from(right, "utf8");
  if (first.byteLength !== second.byteLength) return false;
  return timingSafeEqual(first, second);
}

function normalizeFilters(paths: readonly string[] | undefined): readonly string[] | undefined {
  if (paths === undefined) return undefined;
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("Capture path filters must be a non-empty array");
  const normalized = paths.map((entry) => {
    if (typeof entry !== "string") throw new Error("Capture path filters must be strings");
    const trimmed = entry === "." ? "" : entry.replace(/\/+$/, "");
    if (trimmed === "") throw new Error("Capture path filter must name a path");
    assertCapturablePath(trimmed);
    return trimmed;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error("Capture path filters must be unique");
  return normalized;
}

function matchesFilters(entry: string, filters: readonly string[] | undefined): boolean {
  if (filters === undefined) return true;
  return filters.some((filter) => entry === filter || entry.startsWith(`${filter}/`));
}

function optionalLimit(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

/**
 * Structural check applied to every path Git reports.
 *
 * Control characters are refused, which keeps paths safe for the NUL- and
 * newline-delimited Git plumbing this module drives and removes the last way a
 * path could be confused with framing.
 */
function assertCapturablePath(entry: string): void {
  if (entry.length === 0 || entry.length > MAX_PATH_LENGTH) throw new Error(`Unsupported repository path: ${entry}`);
  if (entry.startsWith("/") || entry.endsWith("/") || entry.includes("\\")) {
    throw new Error(`Unsupported repository path: ${entry}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(entry)) throw new Error(`Unsupported repository path: ${entry}`);
  const components = entry.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw new Error(`Repository path escapes the workspace: ${entry}`);
  }
  if (components[0] === ".git") throw new Error(`Cannot capture Git internals: ${entry}`);
}

/**
 * Refuses paths the contract protects.
 *
 * The manifest rejects them too, but failing here names the offending path
 * instead of surfacing a schema error after an expensive capture.
 */
function assertCapturableTarget(entry: string): void {
  if (entry === RUNNER_HOME_PATH || entry.startsWith(RUNNER_HOME_PREFIX)) {
    throw new Error(`Cannot capture ${entry}: it is Gardener runner state, not repository content`);
  }
  if (isProtectedCapturePath(entry)) {
    throw new Error(`Cannot capture ${entry}: a run may not rewrite workflows, actions, or Gardener's own task definitions`);
  }
}

function normalizeSha1(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(`Invalid ${label} SHA-1`);
  return normalized;
}

function byPath(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
