import { executionWorkspaceId } from "./ids";
import { selectExecutionBackend } from "./policy";
import type { ComputerWorkspaceRpc } from "./rpc";
import type {
  CleanupLease,
  CleanupLeaseRequest,
  DestroyWorkspaceRequest,
  DestroyWorkspaceResult,
  ExecutionAuthorization,
  ExecutionBackend,
  ExecutionWorkspace,
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

const DEFAULT_GIT_OUTPUT_LIMIT = 64 * 1024;

/**
 * Gardener-owned facade over the Computer Durable Object RPC surface. Policy
 * code constructs this adapter; agents receive only selected methods as tools.
 */
export class ComputerExecutionWorkspace implements ExecutionWorkspace {
  readonly workspaceId: string;

  constructor(
    private readonly rpc: ComputerWorkspaceRpc,
    identity: InitializeWorkspaceRequest["identity"],
  ) {
    this.workspaceId = executionWorkspaceId(identity);
  }

  initialize(request: InitializeWorkspaceRequest): Promise<InitializeWorkspaceResult> {
    if (request.workspaceId !== this.workspaceId) {
      throw new Error("Workspace identity does not match its dedicated Durable Object");
    }
    return this.rpc.initialize(request);
  }

  hydrate(request: HydrateWorkspaceRequest): Promise<HydrateWorkspaceResult> {
    return this.rpc.hydrate(request);
  }

  sealHydration(): Promise<SealWorkspaceResult> {
    return this.rpc.sealHydration();
  }

  async execute(
    request: WorkspaceExecutionRequest,
    authorization: ExecutionAuthorization,
  ): Promise<WorkspaceExecutionResult> {
    selectExecutionBackend(request, authorization);
    return this.rpc.executeAuthorized(request, authorization);
  }

  git(request: LocalGitRequest, maxOutputBytes = DEFAULT_GIT_OUTPUT_LIMIT): Promise<LocalGitResult> {
    return this.rpc.gitLocal(request, maxOutputBytes);
  }

  freezePatch(request: FreezePatchRequest): Promise<FreezePatchResult> {
    return this.rpc.freezePatch(request);
  }

  freezeArtifact(request: FreezeArtifactRequest): Promise<FrozenArtifactDescriptor> {
    return this.rpc.freezeArtifact(request);
  }

  readFrozenArtifact(request: ReadFrozenArtifactRequest): Promise<FrozenArtifactContent> {
    return this.rpc.readFrozenArtifact(request);
  }

  syncStatus(backend: ExecutionBackend): Promise<WorkspaceSyncStatus> {
    return this.rpc.syncStatus(backend);
  }

  leaseCleanup(request: CleanupLeaseRequest): Promise<CleanupLease> {
    return this.rpc.leaseCleanup(request);
  }

  destroy(request: DestroyWorkspaceRequest): Promise<DestroyWorkspaceResult> {
    return this.rpc.destroy(request);
  }
}
