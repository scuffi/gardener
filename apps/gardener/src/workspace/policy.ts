import { assertOperationId } from "./ids";
import type {
  ExecutionAuthorization,
  ExecutionBackend,
  WorkspaceExecutionRequest,
} from "./types";

const MAX_SOURCE_BYTES = 64 * 1024;
const MIN_OUTPUT_BYTES = 1;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MIN_RUNTIME_MS = 1;
const MAX_RUNTIME_MS = 10 * 60 * 1000;

const NETWORK_SHELL_TOKEN =
  /(?:^|[\s;&|()])(?:curl|wget|ftp|sftp|ssh|scp|telnet|nc|ncat|netcat|socat|rsync)(?=$|[\s;&|()])/i;
const NETWORK_GIT_TOKEN =
  /(?:^|[\s;&|()])git(?:\s+(?:-[^\s]+\s+)*)?(?:clone|fetch|pull|push|ls-remote)(?=$|[\s;&|()])/i;
const NETWORK_JAVASCRIPT =
  /(?:\bfetch\s*\(|\bWebSocket\b|cloudflare:sockets|node:(?:http|https|net|tls|dgram)|from\s+["'](?:http|https):)/i;

export function selectExecutionBackend(
  request: WorkspaceExecutionRequest,
  authorization: ExecutionAuthorization,
): ExecutionBackend {
  assertOperationId(request.executionId, "execution ID");
  if (!authorization.allowedBackends.includes(request.backend)) {
    throw new Error(`Backend ${request.backend} is outside the run capability set`);
  }
  if (request.backend === "container" && authorization.containerAuthorized !== true) {
    throw new Error("Container execution requires separate caller authorization");
  }
  if (
    !Number.isSafeInteger(authorization.maxOutputBytes) ||
    authorization.maxOutputBytes < MIN_OUTPUT_BYTES ||
    authorization.maxOutputBytes > MAX_OUTPUT_BYTES
  ) {
    throw new Error("Invalid execution output limit");
  }
  if (
    !Number.isSafeInteger(authorization.maxRuntimeMs) ||
    authorization.maxRuntimeMs < MIN_RUNTIME_MS ||
    authorization.maxRuntimeMs > MAX_RUNTIME_MS
  ) {
    throw new Error("Invalid execution runtime limit");
  }
  const timeout = request.timeoutMs ?? authorization.maxRuntimeMs;
  if (!Number.isSafeInteger(timeout) || timeout < MIN_RUNTIME_MS || timeout > authorization.maxRuntimeMs) {
    throw new Error("Execution timeout exceeds the authorized runtime limit");
  }
  if (new TextEncoder().encode(request.source).byteLength > MAX_SOURCE_BYTES) {
    throw new Error("Execution source exceeds 64 KiB");
  }
  assertNetworklessSource(request.backend, request.source);
  return request.backend;
}

export function assertNetworklessSource(backend: ExecutionBackend, source: string): void {
  if (backend === "javascript") {
    if (NETWORK_JAVASCRIPT.test(source)) {
      throw new Error("JavaScript network access is disabled");
    }
    return;
  }
  if (NETWORK_SHELL_TOKEN.test(source) || NETWORK_GIT_TOKEN.test(source)) {
    throw new Error("Network-bearing commands are disabled");
  }
}

export function boundedExecutionTimeout(
  request: WorkspaceExecutionRequest,
  authorization: ExecutionAuthorization,
): number {
  return request.timeoutMs ?? authorization.maxRuntimeMs;
}

export const workspacePolicyLimits = {
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxRuntimeMs: MAX_RUNTIME_MS,
} as const;
