import type {
  CleanupLease,
  CleanupLeaseRequest,
  DestroyWorkspaceRequest,
  DestroyWorkspaceResult,
  ExecutionAuthorization,
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
  ExecutionBackend,
} from "./types";

/** Pure-value RPC boundary. No @cloudflare/computer handles cross it. */
export interface ComputerWorkspaceRpc {
  initialize(request: InitializeWorkspaceRequest): Promise<InitializeWorkspaceResult>;
  hydrate(request: HydrateWorkspaceRequest): Promise<HydrateWorkspaceResult>;
  sealHydration(): Promise<SealWorkspaceResult>;
  executeAuthorized(
    request: WorkspaceExecutionRequest,
    authorization: ExecutionAuthorization,
  ): Promise<WorkspaceExecutionResult>;
  gitLocal(request: LocalGitRequest, maxOutputBytes: number): Promise<LocalGitResult>;
  freezePatch(request: FreezePatchRequest): Promise<FreezePatchResult>;
  freezeArtifact(request: FreezeArtifactRequest): Promise<FrozenArtifactDescriptor>;
  readFrozenArtifact(request: ReadFrozenArtifactRequest): Promise<FrozenArtifactContent>;
  syncStatus(backend: ExecutionBackend): Promise<WorkspaceSyncStatus>;
  leaseCleanup(request: CleanupLeaseRequest): Promise<CleanupLease>;
  destroy(request: DestroyWorkspaceRequest): Promise<DestroyWorkspaceResult>;
}
