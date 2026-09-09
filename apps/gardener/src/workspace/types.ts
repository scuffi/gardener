export const WORKSPACE_BACKENDS = ["shell", "javascript", "container"] as const;

export type ExecutionBackend = (typeof WORKSPACE_BACKENDS)[number];
export type WorkspaceRuntimeValue =
  | null
  | boolean
  | number
  | string
  | WorkspaceRuntimeValue[]
  | { [key: string]: WorkspaceRuntimeValue };

export interface WorkspaceIdentity {
  instanceId: string;
  runId: string;
  taskId: string;
  principalId: string;
}

export type WorkspaceInput =
  | {
      kind: "host-hydration";
      repositoryId: string;
      exactSha: string;
    }
  | {
      kind: "r2-exact-sha";
      repositoryId: string;
      exactSha: string;
    };

export interface InitializeWorkspaceRequest {
  schemaVersion: 1;
  workspaceId: string;
  identity: WorkspaceIdentity;
  input: WorkspaceInput;
}

export interface InitializeWorkspaceResult {
  workspaceId: string;
  inputKind: WorkspaceInput["kind"];
  exactSha: string;
  repositoryRoot: "/workspace/repo";
  readOnlyInputRoot: "/input" | null;
  alreadyInitialized: boolean;
}

export interface HydrationFile {
  path: string;
  content: Uint8Array;
  mode?: number;
}

export interface HydrateWorkspaceRequest {
  files: HydrationFile[];
}

export interface HydrateWorkspaceResult {
  filesWritten: number;
  bytesWritten: number;
}

export interface SealWorkspaceResult {
  exactSha: string;
  sealedAt: number;
}

export interface ExecutionAuthorization {
  allowedBackends: readonly ExecutionBackend[];
  containerAuthorized: boolean;
  maxOutputBytes: number;
  maxRuntimeMs: number;
}

export interface WorkspaceExecutionRequest {
  executionId: string;
  backend: ExecutionBackend;
  source: string;
  cwd?: string;
  input?: WorkspaceRuntimeValue;
  timeoutMs?: number;
}

export type SyncSummary =
  | { status: "complete"; applied: number; skipped: number }
  | { status: "pending"; applied: number; skipped: number; error: string }
  | { status: "not-applicable" };

export type ExecutionOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "sync-pending"
  | "ambiguous";

export interface WorkspaceExecutionResult {
  executionId: string;
  backend: ExecutionBackend;
  outcome: ExecutionOutcome;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  value?: WorkspaceRuntimeValue;
  outputBytes: number;
  outputTruncated: boolean;
  sync: SyncSummary;
  replayDisposition: "return-recorded" | "deny-automatic-replay";
  error?: string;
}

export interface LocalGitRequest {
  operationId: string;
  argv: string[];
  cwd?: string;
}

export interface LocalGitResult {
  operationId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  outputBytes: number;
  outputTruncated: boolean;
}

export interface FrozenArtifactDescriptor {
  artifactId: string;
  kind: "patch" | "file";
  path: string;
  sha256: string;
  bytes: number;
  exactSourceSha: string;
  createdAt: number;
  mediaType: string;
}

export interface FreezePatchRequest {
  artifactId: string;
  expectedBaseSha: string;
  directory?: string;
  maxBytes?: number;
}

export interface FreezePatchResult {
  artifact: FrozenArtifactDescriptor;
  changedPaths: string[];
}

export interface FreezeArtifactRequest {
  artifactId: string;
  sourcePath: string;
  mediaType: string;
  maxBytes?: number;
}

export interface ReadFrozenArtifactRequest {
  artifactId: string;
  maxBytes?: number;
}

export interface FrozenArtifactContent {
  descriptor: FrozenArtifactDescriptor;
  content: Uint8Array;
}

export interface CleanupLeaseRequest {
  owner: string;
  ttlMs: number;
}

export interface CleanupLease {
  token: string;
  owner: string;
  issuedAt: number;
  expiresAt: number;
}

export interface DestroyWorkspaceRequest {
  leaseToken: string;
  owner: string;
}

export interface DestroyWorkspaceResult {
  destroyed: true;
  destroyedAt: number;
}

export type WorkspaceSyncStatus =
  | { status: "idle"; backend: ExecutionBackend }
  | { status: "pending"; backend: ExecutionBackend; attempt: number; notBefore: number; error?: string }
  | { status: "complete"; backend: ExecutionBackend; applied: number; skipped: number }
  | { status: "exhausted"; backend: ExecutionBackend; attempt: number; error: string }
  | { status: "lost"; backend: ExecutionBackend; error: string };

export interface ExecutionWorkspace {
  readonly workspaceId: string;
  initialize(request: InitializeWorkspaceRequest): Promise<InitializeWorkspaceResult>;
  hydrate(request: HydrateWorkspaceRequest): Promise<HydrateWorkspaceResult>;
  sealHydration(): Promise<SealWorkspaceResult>;
  execute(request: WorkspaceExecutionRequest, authorization: ExecutionAuthorization): Promise<WorkspaceExecutionResult>;
  git(request: LocalGitRequest, maxOutputBytes?: number): Promise<LocalGitResult>;
  freezePatch(request: FreezePatchRequest): Promise<FreezePatchResult>;
  freezeArtifact(request: FreezeArtifactRequest): Promise<FrozenArtifactDescriptor>;
  readFrozenArtifact(request: ReadFrozenArtifactRequest): Promise<FrozenArtifactContent>;
  syncStatus(backend: ExecutionBackend): Promise<WorkspaceSyncStatus>;
  leaseCleanup(request: CleanupLeaseRequest): Promise<CleanupLease>;
  destroy(request: DestroyWorkspaceRequest): Promise<DestroyWorkspaceResult>;
}
