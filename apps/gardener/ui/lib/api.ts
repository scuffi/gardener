import type { WorkflowSpecV2 } from "@gardener/contracts";
import type { AppState, HealthState, PolicyMode, RunDetail, SetupProfile, WorkflowCreateResult, WorkflowDetail, WorkflowRevisionDetail, WorkflowValidation } from "./types";

export interface SessionState { authenticated: boolean; githubLogin?: string }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function consumeReturnedIdentity(): Promise<boolean> {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const returned = hash.get("identity_token") ?? hash.get("token");
  if (!returned) return false;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  await api<SessionState>("/api/auth/session", { method: "POST", body: JSON.stringify({ token: returned }) });
  return true;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    const fallback = response.status === 401
      ? "Your dashboard session has expired. Sign in again to continue."
      : `Request failed (${response.status}).`;
    throw new ApiError(body.error || fallback, response.status);
  }
  return body as T;
}

export const gardenerApi = {
  health: () => api<HealthState>("/api/health"),
  session: () => api<SessionState>("/api/auth/session"),
  signOut: () => api<{ signedOut: true }>("/api/auth/logout", { method: "POST" }),
  state: () => api<AppState>("/api/state"),
  run: (id: string) => api<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  beginInstallation: () => api<{ installationUrl: string }>("/api/install/start", { method: "POST" }),
  syncRepositories: () => api<{ repositories: unknown[] }>("/api/repositories/sync", { method: "POST" }),
  activate: (profile: SetupProfile) => api<{ activated: true; profile: SetupProfile }>("/api/setup/activate", {
    method: "POST",
    body: JSON.stringify({ profile }),
  }),
  setPaused: (paused: boolean) => api<{ globalPaused: boolean }>("/api/settings/pause", {
    method: "POST",
    body: JSON.stringify({ paused }),
  }),
  setRepositoryPaused: (id: string, paused: boolean) => api<{ id: string; paused: boolean }>(`/api/repositories/${encodeURIComponent(id)}/pause`, {
    method: "PUT",
    body: JSON.stringify({ paused }),
  }),
  validateWorkflow: (spec: WorkflowSpecV2) => api<WorkflowValidation>("/api/workflows/validate", {
    method: "POST",
    body: JSON.stringify(spec),
  }),
  createWorkflow: (spec: WorkflowSpecV2) => api<WorkflowCreateResult>("/api/workflows", {
    method: "POST",
    body: JSON.stringify(spec),
  }),
  createWorkflowRevision: (id: string, baseRevision: number, spec: WorkflowSpecV2) => api<WorkflowCreateResult>(`/api/workflows/${encodeURIComponent(id)}/revisions`, {
    method: "POST",
    body: JSON.stringify({ baseRevision, spec }),
  }),
  workflow: (id: string) => api<WorkflowDetail>(`/api/workflows/${encodeURIComponent(id)}`),
  workflowRevision: (id: string, revision: number) => api<WorkflowRevisionDetail>(`/api/workflows/${encodeURIComponent(id)}/revisions/${revision}`),
  activateWorkflowRevision: (id: string, revision: number) => api<{ workflowId: string; revision: number; activated: true }>(`/api/workflows/${encodeURIComponent(id)}/revisions/${revision}/activate`, { method: "POST" }),
  setWorkflow: (id: string, enabled: boolean) => api<{ id: string; enabled: boolean }>(`/api/workflows/${encodeURIComponent(id)}/status`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  }),
  setPolicy: (operation: string, mode: PolicyMode) => api<{ operation: string; mode: PolicyMode }>(`/api/policies/${encodeURIComponent(operation)}`, {
    method: "PUT",
    body: JSON.stringify({ mode }),
  }),
  setPolicies: (policies: Array<{ operation: string; mode: PolicyMode }>) => api<{ policies: Array<{ operation: string; mode: PolicyMode }> }>("/api/policies", {
    method: "PUT",
    body: JSON.stringify({ policies }),
  }),
  approve: (id: string) => api<{ id: string; status: string }>(`/api/approvals/${encodeURIComponent(id)}/approve`, { method: "POST" }),
  reject: (id: string) => api<{ id: string; status: string }>(`/api/approvals/${encodeURIComponent(id)}/reject`, { method: "POST" }),
  testAi: () => api<{ ok: true; model: string; usage?: { costUsd?: number } }>("/api/health/ai", { method: "POST" }),
};
