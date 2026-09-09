import { createHash } from "node:crypto";
import type { WorkspaceIdentity } from "./types";

const COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function assertIdentityComponent(label: string, value: string): void {
  if (!COMPONENT_PATTERN.test(value) || value.includes("..") || value.includes("//")) {
    throw new Error(`Invalid workspace ${label}`);
  }
}

export function assertOperationId(value: string, label = "operation ID"): void {
  if (!OPERATION_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

/**
 * Produces the name passed to DurableObjectNamespace.idFromName(). The task and
 * principal are mandatory so parallel principals never share writable state.
 */
export function executionWorkspaceId(identity: WorkspaceIdentity): string {
  assertIdentityComponent("instance ID", identity.instanceId);
  assertIdentityComponent("run ID", identity.runId);
  assertIdentityComponent("task ID", identity.taskId);
  assertIdentityComponent("principal ID", identity.principalId);

  const tuple = ["gardener-computer-v1", identity.instanceId, identity.runId, identity.taskId, identity.principalId]
    .map((part) => `${new TextEncoder().encode(part).byteLength}:${part}`)
    .join("");
  const digest = createHash("sha256").update(tuple, "utf8").digest("hex");
  return `gardener-computer-v1-${digest}`;
}

export function assertExactGitSha(value: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error("Input must be pinned to an exact lowercase Git SHA");
  }
}

export function exactShaR2Prefix(repositoryId: string, exactSha: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(repositoryId)) {
    throw new Error("Repository ID must be an immutable numeric provider ID");
  }
  assertExactGitSha(exactSha);
  return `repository-snapshots/${repositoryId}/${exactSha}/`;
}
