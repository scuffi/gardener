import {
  R2Bucket as ComputerR2Bucket,
  Workspace,
  type DurableObjectStorageLike,
  type R2BucketBinding,
  type WorkspaceRuntimeLoader,
  type WorkspaceRuntimeResult,
  type WorkspaceStub,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import {
  WorkerShellBackend,
  type WorkerShellLoader,
} from "@cloudflare/computer/backends/worker-shell";
import { DurableObject } from "cloudflare:workers";
import { CleanupLeaseManager } from "./cleanup";
import { assertExactGitSha, assertOperationId, exactShaR2Prefix, executionWorkspaceId } from "./ids";
import { assertLocalOnlyGitCli, createLocalOnlyGitClientFactory } from "./local-git";
import { boundedExecutionTimeout, selectExecutionBackend, workspacePolicyLimits } from "./policy";
import { ambiguousExecutionResult, boundTextResult, classifyExecutionResult } from "./result";
import type { ComputerWorkspaceRpc } from "./rpc";
import { DurableSyncScheduler } from "./sync";
import type {
  CleanupLease,
  CleanupLeaseRequest,
  DestroyWorkspaceRequest,
  DestroyWorkspaceResult,
  ExecutionAuthorization,
  ExecutionBackend,
  FreezeArtifactRequest,
  FreezePatchRequest,
  FreezePatchResult,
  FrozenArtifactContent,
  FrozenArtifactDescriptor,
  HydrateWorkspaceRequest,
  HydrateWorkspaceResult,
  InitializeWorkspaceRequest,
  InitializeWorkspaceResult,
  LocalGitRequest,
  LocalGitResult,
  ReadFrozenArtifactRequest,
  SealWorkspaceResult,
  WorkspaceExecutionRequest,
  WorkspaceExecutionResult,
  WorkspaceSyncStatus,
} from "./types";

const INITIALIZATION_KEY = "gardener:computer:initialization";
const SEALED_KEY = "gardener:computer:sealed";
const CLEANUP_LEASE_KEY = "gardener:computer:cleanup-lease";
const HYDRATION_STATE_KEY = "gardener:computer:hydration-state";
const EXECUTION_PREFIX = "gardener:computer:execution:";
const GIT_PREFIX = "gardener:computer:git:";
const ARTIFACT_PREFIX = "gardener:computer:artifact:";
const REPOSITORY_ROOT = "/workspace/repo" as const;
const INPUT_ROOT = "/input" as const;
const FROZEN_ROOT = "/workspace/.gardener/frozen";
const MAX_HYDRATION_FILE_BYTES = 1024 * 1024;
const MAX_HYDRATION_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_HYDRATION_FILES = 256;
const MAX_R2_INPUT_ENTRIES = 2_000;
const MAX_R2_INPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_ARTIFACT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

interface ComputerLoader extends WorkerShellLoader, WorkspaceRuntimeLoader {}

export interface ComputerWorkspaceEnv {
  COMPUTER_LOADER: ComputerLoader;
  COMPUTER_INPUTS?: R2Bucket;
}

interface StoredExecution {
  requestHash: string;
  state: "started" | "finished";
  result?: WorkspaceExecutionResult;
}

interface StoredGitOperation {
  requestHash: string;
  state: "started" | "finished";
  result?: LocalGitResult;
}

interface SealedState {
  exactSha: string;
  sealedAt: number;
}

interface HydrationState {
  files: number;
  bytes: number;
}

const ComputerContainerBase = withWorkspaceContainer(class extends DurableObject<ComputerWorkspaceEnv> {});

/**
 * One Durable Object instance owns one run/task/principal workspace. It is not
 * an authority boundary by itself: callers must pass a policy-derived backend
 * authorization, and all external effects remain outside this object.
 */
export class ComputerWorkspace extends ComputerContainerBase implements ComputerWorkspaceRpc {
  #workspacePromise: Promise<Workspace> | undefined;
  #containerBackend: CloudflareContainerBackend | undefined;
  #liveExecutions = new Map<string, ExecutionBackend>();
  #destroying = false;
  #destroyedAt: number | undefined;

  async initialize(request: InitializeWorkspaceRequest): Promise<InitializeWorkspaceResult> {
    this.#assertActive();
    validateInitialization(request);
    const existing = await this.ctx.storage.get<InitializeWorkspaceRequest>(INITIALIZATION_KEY);
    if (existing && canonicalJson(existing) !== canonicalJson(request)) {
      throw new Error("Workspace has already been initialized with different immutable input");
    }

    if (!existing) await this.ctx.storage.put(INITIALIZATION_KEY, request);
    const immutable = existing ?? request;
    const workspace = await this.#workspace();
    await workspace.fs.mkdir(REPOSITORY_ROOT, { recursive: true });
    await workspace.fs.mkdir(FROZEN_ROOT, { recursive: true });

    // Initialization can be interrupted after its immutable identity is stored.
    // Retrying must finish materialization/sealing rather than falsely reporting
    // success solely because the identity record exists.
    if (immutable.input.kind === "r2-exact-sha" && !(await this.ctx.storage.get<SealedState>(SEALED_KEY))) {
      if (!this.env.COMPUTER_INPUTS) throw new Error("R2 snapshot input binding is unavailable");
      await workspace.ensureMountsIndexed();
      await this.#materializeReadOnlyInput(workspace);
      await this.ctx.storage.put<SealedState>(SEALED_KEY, {
        exactSha: immutable.input.exactSha,
        sealedAt: Date.now(),
      });
    }
    return initializationResult(immutable, existing !== undefined);
  }

  async hydrate(request: HydrateWorkspaceRequest): Promise<HydrateWorkspaceResult> {
    this.#assertActive();
    const initialization = await this.#initialization();
    if (initialization.input.kind !== "host-hydration") {
      throw new Error("Direct hydration is disabled for R2-mounted input");
    }
    if (await this.ctx.storage.get<SealedState>(SEALED_KEY)) {
      throw new Error("Workspace input is already sealed");
    }
    if (!Array.isArray(request.files) || request.files.length === 0 || request.files.length > MAX_HYDRATION_FILES) {
      throw new Error(`Hydration requires 1-${MAX_HYDRATION_FILES} files per call`);
    }

    let hydration = (await this.ctx.storage.get<HydrationState>(HYDRATION_STATE_KEY)) ?? { files: 0, bytes: 0 };
    if (hydration.files + request.files.length > MAX_R2_INPUT_ENTRIES) {
      throw new Error("Hydrated snapshot has too many files");
    }

    // Validate the complete batch before mutating the VFS. Persist cumulative
    // usage after every successful write so a later write failure cannot leave
    // unaccounted files that let repeated partial batches bypass global limits.
    const paths = new Set<string>();
    const prepared = request.files.map((file) => {
      const path = hydrationPath(file.path);
      if (paths.has(path)) throw new Error("Hydration paths must be unique within a batch");
      paths.add(path);
      if (!(file.content instanceof Uint8Array)) throw new Error("Hydration content must be bytes");
      assertCredentialFreeHydration(relativeHydrationPath(path), file.content);
      if (file.content.byteLength > MAX_HYDRATION_FILE_BYTES) {
        throw new Error(`Hydration file exceeds ${MAX_HYDRATION_FILE_BYTES} bytes`);
      }
      if (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)) {
        throw new Error("Invalid hydrated file mode");
      }
      return { file, path };
    });
    const bytesWritten = prepared.reduce((total, item) => total + item.file.content.byteLength, 0);
    if (bytesWritten > MAX_HYDRATION_BATCH_BYTES) throw new Error("Hydration batch exceeds 8 MiB");
    if (hydration.bytes + bytesWritten > MAX_R2_INPUT_BYTES) throw new Error("Hydrated snapshot exceeds 64 MiB");

    const workspace = await this.#workspace();
    for (const { file, path } of prepared) {
      const parent = path.slice(0, path.lastIndexOf("/")) || REPOSITORY_ROOT;
      await workspace.fs.mkdir(parent, { recursive: true });
      await workspace.fs.writeFile(path, file.content, file.mode === undefined ? undefined : { mode: file.mode });
      hydration = { files: hydration.files + 1, bytes: hydration.bytes + file.content.byteLength };
      await this.ctx.storage.put<HydrationState>(HYDRATION_STATE_KEY, hydration);
    }
    return { filesWritten: request.files.length, bytesWritten };
  }

  async sealHydration(): Promise<SealWorkspaceResult> {
    this.#assertActive();
    const initialization = await this.#initialization();
    const existing = await this.ctx.storage.get<SealedState>(SEALED_KEY);
    if (existing) return existing;
    const state: SealedState = { exactSha: initialization.input.exactSha, sealedAt: Date.now() };
    await this.ctx.storage.put(SEALED_KEY, state);
    return state;
  }

  async executeAuthorized(
    request: WorkspaceExecutionRequest,
    authorization: ExecutionAuthorization,
  ): Promise<WorkspaceExecutionResult> {
    this.#assertActive();
    const backend = selectExecutionBackend(request, authorization);
    await this.#sealed();
    const requestHash = await sha256Hex(
      canonicalJson({
        request,
        authorization: {
          ...authorization,
          allowedBackends: [...authorization.allowedBackends].sort(),
        },
      }),
    );
    const key = `${EXECUTION_PREFIX}${request.executionId}`;
    const existing = await this.ctx.storage.get<StoredExecution>(key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error("Execution ID was reused with different input");
      if (existing.state === "finished" && existing.result) return existing.result;
      return ambiguousExecutionResult({
        executionId: request.executionId,
        backend,
        error: new Error("Execution started without a durably observed result; automatic replay denied"),
      });
    }
    await this.ctx.storage.put<StoredExecution>(key, { requestHash, state: "started" });

    let result: WorkspaceExecutionResult;
    try {
      const workspace = await this.#workspace();
      const cwd = workspacePath(request.cwd ?? REPOSITORY_ROOT);
      const handle = await workspace.runtime.exec(request.source, {
        id: request.executionId,
        backend,
        cwd,
        encoding: "utf8",
        ...(request.input === undefined ? {} : { input: request.input }),
        timeoutMs: boundedExecutionTimeout(request, authorization),
        env: safeExecutionEnvironment(),
      });
      this.#liveExecutions.set(request.executionId, backend);
      try {
        const runtimeResult = await handle.result();
        result = classifyExecutionResult({
          executionId: request.executionId,
          backend,
          result: runtimeResult as WorkspaceRuntimeResult<"utf8">,
          maxOutputBytes: authorization.maxOutputBytes,
        });
      } finally {
        this.#liveExecutions.delete(request.executionId);
        handle[Symbol.dispose]();
        try {
          await workspace.runtime.disposeExec(request.executionId, { backend });
        } catch {
          // Result durability is independent from best-effort remote handle cleanup.
        }
      }
    } catch (error) {
      result = ambiguousExecutionResult({ executionId: request.executionId, backend, error });
    }

    if (!this.#destroying) {
      await this.ctx.storage.put<StoredExecution>(key, { requestHash, state: "finished", result });
    }
    return result;
  }

  async gitLocal(request: LocalGitRequest, maxOutputBytes: number): Promise<LocalGitResult> {
    this.#assertActive();
    assertOperationId(request.operationId, "Git operation ID");
    assertLocalOnlyGitCli({ argv: request.argv });
    assertOutputLimit(maxOutputBytes);
    await this.#sealed();
    const normalized = {
      operationId: request.operationId,
      argv: [...request.argv],
      ...(request.cwd === undefined ? {} : { cwd: workspacePath(request.cwd) }),
    };
    const requestHash = await sha256Hex(canonicalJson(normalized));
    const key = `${GIT_PREFIX}${request.operationId}`;
    const existing = await this.ctx.storage.get<StoredGitOperation>(key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error("Git operation ID was reused with different input");
      if (existing.state === "finished" && existing.result) return existing.result;
      throw new Error("Git result is ambiguous; automatic replay denied");
    }
    await this.ctx.storage.put<StoredGitOperation>(key, { requestHash, state: "started" });

    const workspace = await this.#workspace();
    let raw: { stdout: string; stderr: string; exitCode: number };
    try {
      raw = await workspace.git.cli({
        argv: normalized.argv,
        cwd: normalized.cwd ?? REPOSITORY_ROOT,
        env: safeExecutionEnvironment(),
      });
    } catch (error) {
      throw new Error("Git result is ambiguous; automatic replay denied", { cause: error });
    }
    const bounded = boundTextResult(raw.stdout, raw.stderr, maxOutputBytes);
    const result: LocalGitResult = {
      operationId: request.operationId,
      exitCode: raw.exitCode,
      ...bounded,
    };
    if (!this.#destroying) {
      await this.ctx.storage.put<StoredGitOperation>(key, { requestHash, state: "finished", result });
    }
    return result;
  }

  async freezePatch(request: FreezePatchRequest): Promise<FreezePatchResult> {
    this.#assertActive();
    assertOperationId(request.artifactId, "artifact ID");
    assertExactGitSha(request.expectedBaseSha);
    const sealed = await this.#sealed();
    if (sealed.exactSha !== request.expectedBaseSha) throw new Error("Patch base SHA does not match sealed input");
    const maxBytes = artifactLimit(request.maxBytes);
    await this.#assertNoUnresolvedSync();
    const workspace = await this.#workspace();
    const directory = workspacePath(request.directory ?? REPOSITORY_ROOT);
    const actualBase = await workspace.git.revParse({ dir: directory, ref: "HEAD" });
    if (actualBase.toLowerCase() !== request.expectedBaseSha) throw new Error("Workspace HEAD changed from exact input SHA");

    const patch = await workspace.git.diff({ dir: directory, ref: "HEAD" });
    const patchBytes = new TextEncoder().encode(patch);
    if (patchBytes.byteLength > maxBytes) throw new Error("Frozen patch exceeds its authorized byte limit");
    const changedPaths = (await workspace.git.diffSummary({ dir: directory, ref: "HEAD" })).map((entry) => entry.path);
    const descriptor = await this.#storeFrozenArtifact({
      artifactId: request.artifactId,
      kind: "patch",
      content: patchBytes,
      mediaType: "text/x-diff; charset=utf-8",
      exactSourceSha: sealed.exactSha,
    });
    return { artifact: descriptor, changedPaths };
  }

  async freezeArtifact(request: FreezeArtifactRequest): Promise<FrozenArtifactDescriptor> {
    this.#assertActive();
    assertOperationId(request.artifactId, "artifact ID");
    if (!/^[\w.+-]+\/[\w.+-]+(?:;\s*charset=[\w-]+)?$/i.test(request.mediaType)) {
      throw new Error("Invalid artifact media type");
    }
    const sealed = await this.#sealed();
    await this.#assertNoUnresolvedSync();
    const content = await this.#readFileBounded(workspacePath(request.sourcePath), artifactLimit(request.maxBytes));
    return this.#storeFrozenArtifact({
      artifactId: request.artifactId,
      kind: "file",
      content,
      mediaType: request.mediaType,
      exactSourceSha: sealed.exactSha,
    });
  }

  async readFrozenArtifact(request: ReadFrozenArtifactRequest): Promise<FrozenArtifactContent> {
    this.#assertActive();
    assertOperationId(request.artifactId, "artifact ID");
    const descriptor = await this.ctx.storage.get<FrozenArtifactDescriptor>(`${ARTIFACT_PREFIX}${request.artifactId}`);
    if (!descriptor) throw new Error("Frozen artifact does not exist");
    const content = await this.#readFileBounded(descriptor.path, artifactLimit(request.maxBytes));
    if ((await sha256Hex(content)) !== descriptor.sha256) throw new Error("Frozen artifact integrity check failed");
    return { descriptor, content };
  }

  syncStatus(backend: ExecutionBackend): Promise<WorkspaceSyncStatus> {
    this.#assertActive();
    return this.#syncScheduler().status(backend);
  }

  async leaseCleanup(request: CleanupLeaseRequest): Promise<CleanupLease> {
    this.#assertActive();
    return this.#cleanupLeaseManager().acquire(request);
  }

  async destroy(request: DestroyWorkspaceRequest): Promise<DestroyWorkspaceResult> {
    if (this.#destroyedAt !== undefined) return { destroyed: true, destroyedAt: this.#destroyedAt };
    if (this.#destroying) throw new Error("Workspace destruction is already in progress");
    await this.#cleanupLeaseManager().consume(request.leaseToken, request.owner);
    this.#destroying = true;
    if (this.#workspacePromise) {
      const workspace = await this.#workspacePromise;
      for (const [executionId, backend] of this.#liveExecutions) {
        try {
          await workspace.runtime.killExec(executionId, { backend, signal: "SIGKILL" });
        } catch {
          // Continue bounded cleanup even if a backend has already disappeared.
        }
        try {
          await workspace.runtime.disposeExec(executionId, { backend });
        } catch {
          // Continue bounded cleanup even if a handle has already been disposed.
        }
      }
      this.#liveExecutions.clear();
      await workspace.close();
    }
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    await this.ctx.storage.deleteAll();
    this.#workspacePromise = undefined;
    this.#containerBackend = undefined;
    this.#destroyedAt = Date.now();
    return { destroyed: true, destroyedAt: this.#destroyedAt };
  }

  async alarm(): Promise<void> {
    const workspace = await this.#workspace();
    for (const backend of ["container"] as const) {
      const intent = await this.#syncScheduler().get(backend);
      if (!intent || intent.notBefore > Date.now()) continue;
      const result = await workspace.retryPendingSync(backend);
      await this.#syncScheduler().record(backend, result);
    }
  }

  /** Required internally by Computer's worker backends. Do not expose this DO binding to agents. */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    return (await this.#workspace()).stub();
  }

  async fetch(request: Request): Promise<Response> {
    await this.#workspace();
    if (!this.#containerBackend) return new Response("Container backend unavailable", { status: 503 });
    return this.#containerBackend.handleFetch(request);
  }

  #assertActive(): void {
    if (this.#destroying || this.#destroyedAt !== undefined) throw new Error("Workspace is being destroyed or has been destroyed");
  }

  async #workspace(): Promise<Workspace> {
    if (!this.#workspacePromise) {
      const pending = this.#createWorkspace();
      this.#workspacePromise = pending;
      void pending.catch(() => {
        if (this.#workspacePromise === pending) this.#workspacePromise = undefined;
      });
    }
    return this.#workspacePromise;
  }

  async #createWorkspace(): Promise<Workspace> {
    const initialization = await this.#initialization();
    const workspaceRef = { binding: "COMPUTER_WORKSPACES", id: this.ctx.id.toString() };
    this.#containerBackend = new CloudflareContainerBackend({
      id: "container",
      container: () => this,
      workspace: workspaceRef,
      egress: { mode: "none" },
      containerEnv: safeExecutionEnvironment(),
    });
    const mounts =
      initialization.input.kind === "r2-exact-sha" && this.env.COMPUTER_INPUTS
        ? {
            [INPUT_ROOT]: ComputerR2Bucket(this.env.COMPUTER_INPUTS as unknown as R2BucketBinding, {
              prefix: exactShaR2Prefix(initialization.input.repositoryId, initialization.input.exactSha),
              mode: "read-only",
              maxBytes: MAX_R2_INPUT_BYTES,
              maxEntries: MAX_R2_INPUT_ENTRIES,
            }),
          }
        : undefined;
    return new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      sessionId: initialization.workspaceId,
      backends: [
        new WorkerShellBackend({
          id: "shell",
          loader: this.env.COMPUTER_LOADER,
          workspace: workspaceRef,
          ctx: this.ctx,
          egress: { mode: "none" },
          commands: [],
        }),
        new WorkerJavaScriptBackend({
          id: "javascript",
          loader: this.env.COMPUTER_LOADER,
          root: REPOSITORY_ROOT,
          access: "read-write",
          defaultTimeoutMs: 5_000,
          maxTimeoutMs: 10_000,
          maxSourceBytes: workspacePolicyLimits.maxSourceBytes,
          maxInputBytes: 32 * 1024,
          maxStdinBytes: 0,
          maxEnvBytes: 2 * 1024,
          maxResultBytes: 64 * 1024,
          maxStdioBytes: 64 * 1024,
          maxCapabilityBytes: 64 * 1024,
          maxHostCallMs: 5_000,
          maxConcurrentCapabilityCalls: 2,
          maxCapabilityCalls: 32,
          maxCapabilityRequestBytes: 16 * 1024,
          maxCapabilityResponseBytes: 64 * 1024,
          maxDirectoryEntries: 512,
          maxConcurrentExecutions: 2,
          maxExecutionSubscribers: 4,
          retentionMs: 60_000,
          maxRetainedExecutions: 16,
          compatibilityDate: "2026-09-04",
          compatibilityFlags: ["nodejs_compat"],
          egress: { mode: "none" },
          globalOutbound: null,
          allowGitNetwork: false,
          allowArtifactNetwork: false,
          trustedModules: {},
        }),
        this.#containerBackend,
      ],
      ...(mounts === undefined ? {} : { mounts }),
      retryScheduler: this.#syncScheduler(),
      retry: { initialDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5 },
      git: createLocalOnlyGitClientFactory(),
      defaultGitIdentity: { name: "Gardener Agent", email: "agent@gardener.invalid" },
    });
  }

  async #initialization(): Promise<InitializeWorkspaceRequest> {
    const value = await this.ctx.storage.get<InitializeWorkspaceRequest>(INITIALIZATION_KEY);
    if (!value) throw new Error("Workspace has not been initialized");
    return value;
  }

  async #sealed(): Promise<SealedState> {
    const value = await this.ctx.storage.get<SealedState>(SEALED_KEY);
    if (!value) throw new Error("Workspace input has not been sealed");
    return value;
  }

  async #assertNoUnresolvedSync(): Promise<void> {
    const status = await this.#syncScheduler().status("container");
    if (status.status === "pending" || status.status === "exhausted" || status.status === "lost") {
      throw new Error(`Cannot freeze artifacts while container sync is ${status.status}`);
    }
  }

  #syncScheduler(): DurableSyncScheduler {
    return new DurableSyncScheduler(this.ctx.storage);
  }

  #cleanupLeaseManager(): CleanupLeaseManager {
    return new CleanupLeaseManager({
      get: () => this.ctx.storage.get<CleanupLease>(CLEANUP_LEASE_KEY),
      put: (lease) => this.ctx.storage.put(CLEANUP_LEASE_KEY, lease),
      delete: async () => {
        await this.ctx.storage.delete(CLEANUP_LEASE_KEY);
      },
    });
  }

  async #materializeReadOnlyInput(workspace: Workspace): Promise<void> {
    const entries = await workspace.fs.find(INPUT_ROOT, undefined, { limit: MAX_R2_INPUT_ENTRIES + 1 });
    if (entries.length > MAX_R2_INPUT_ENTRIES) throw new Error("R2 snapshot has too many entries");
    let bytes = 0;
    for (const entry of entries) {
      const relative = entry.path.slice(INPUT_ROOT.length).replace(/^\/+/, "");
      if (!relative) continue;
      const destination = hydrationPath(relative);
      if (entry.type === "dir") {
        await workspace.fs.mkdir(destination, { recursive: true });
        continue;
      }
      const stat = await workspace.fs.stat(entry.path);
      bytes += stat.size;
      if (bytes > MAX_R2_INPUT_BYTES) throw new Error("R2 snapshot exceeds workspace input limit");
      await workspace.fs.mkdir(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
      if (relative.toLowerCase() === ".git/config") {
        const configBytes = await this.#readFileBounded(entry.path, Math.min(stat.size, MAX_HYDRATION_FILE_BYTES));
        assertCredentialFreeHydration(relative, configBytes);
        await workspace.fs.writeFile(destination, configBytes, { mode: stat.mode & 0o777 });
      } else {
        await workspace.fs.writeFile(destination, await workspace.fs.readFile(entry.path), { mode: stat.mode & 0o777 });
      }
    }
  }

  async #storeFrozenArtifact(options: {
    artifactId: string;
    kind: FrozenArtifactDescriptor["kind"];
    content: Uint8Array;
    mediaType: string;
    exactSourceSha: string;
  }): Promise<FrozenArtifactDescriptor> {
    const key = `${ARTIFACT_PREFIX}${options.artifactId}`;
    const existing = await this.ctx.storage.get<FrozenArtifactDescriptor>(key);
    const digest = await sha256Hex(options.content);
    if (existing) {
      if (existing.sha256 !== digest || existing.kind !== options.kind) {
        throw new Error("Artifact ID was reused for different frozen content");
      }
      return existing;
    }
    const extension = options.kind === "patch" ? ".patch" : ".bin";
    const path = `${FROZEN_ROOT}/${options.artifactId}${extension}`;
    const workspace = await this.#workspace();
    await workspace.fs.writeFile(path, options.content, { exclusive: true, mode: 0o400 });
    const descriptor: FrozenArtifactDescriptor = {
      artifactId: options.artifactId,
      kind: options.kind,
      path,
      sha256: digest,
      bytes: options.content.byteLength,
      exactSourceSha: options.exactSourceSha,
      createdAt: Date.now(),
      mediaType: options.mediaType,
    };
    await this.ctx.storage.put(key, descriptor);
    return descriptor;
  }

  async #readFileBounded(path: string, maxBytes: number): Promise<Uint8Array> {
    const workspace = await this.#workspace();
    const stat = await workspace.fs.stat(path);
    if (!stat.isFile) throw new Error("Artifact source is not a file");
    if (stat.size > maxBytes) throw new Error("Artifact exceeds its authorized byte limit");
    const stream = await workspace.fs.readFile(path);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error("Artifact stream exceeds its authorized byte limit");
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

function validateInitialization(request: InitializeWorkspaceRequest): void {
  if (request.schemaVersion !== 1) throw new Error("Unsupported workspace schema version");
  if (executionWorkspaceId(request.identity) !== request.workspaceId) {
    throw new Error("Workspace ID does not match run, task, and parallel principal identity");
  }
  if (!/^[1-9][0-9]{0,19}$/.test(request.input.repositoryId)) {
    throw new Error("Repository ID must be an immutable numeric provider ID");
  }
  assertExactGitSha(request.input.exactSha);
}

function initializationResult(
  request: InitializeWorkspaceRequest,
  alreadyInitialized: boolean,
): InitializeWorkspaceResult {
  return {
    workspaceId: request.workspaceId,
    inputKind: request.input.kind,
    exactSha: request.input.exactSha,
    repositoryRoot: REPOSITORY_ROOT,
    readOnlyInputRoot: request.input.kind === "r2-exact-sha" ? INPUT_ROOT : null,
    alreadyInitialized,
  };
}

function hydrationPath(relative: string): string {
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Hydration path must be a normalized repository-relative path");
  }
  if (/(?:^|\/)(?:\.git-credentials|\.netrc|\.npmrc|\.pypirc|id_rsa|id_ed25519)(?:$|\/)/i.test(relative)) {
    throw new Error("Credential-bearing files are forbidden in execution workspaces");
  }
  return `${REPOSITORY_ROOT}/${relative}`;
}

function workspacePath(value: string): string {
  if (
    (value !== "/workspace" && !value.startsWith("/workspace/")) ||
    value.includes("\\") ||
    value.split("/").includes("..")
  ) {
    throw new Error("Workspace path escapes the isolated workspace root");
  }
  return value.replace(/\/+$/, "") || "/workspace";
}

function relativeHydrationPath(path: string): string {
  return path.slice(`${REPOSITORY_ROOT}/`.length);
}

function assertCredentialFreeHydration(relative: string, content: Uint8Array): void {
  if (relative.toLowerCase() !== ".git/config") return;
  const config = new TextDecoder().decode(content);
  if (/(?:\[\s*(?:remote|credential)|\b(?:url|proxy|helper|extraheader)\s*=)/i.test(config)) {
    throw new Error("Git config containing remotes, credentials, or network settings is forbidden");
  }
}

function safeExecutionEnvironment(): Record<string, string> {
  return {
    CI: "1",
    HOME: "/workspace/.home",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function assertOutputLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > workspacePolicyLimits.maxOutputBytes) {
    throw new Error("Invalid output byte limit");
  }
}

function artifactLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_BYTES) {
    throw new Error("Invalid artifact byte limit");
  }
  return limit;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
