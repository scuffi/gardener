import type { AppState, HealthState, PolicyMode, RunDetail, SetupProfile } from "./types";

const sessionKey = "gardener.identity";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export function consumeReturnedIdentity(): void {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const returned = hash.get("identity_token") ?? hash.get("token");
  if (!returned) return;
  sessionStorage.setItem(sessionKey, returned);
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

export function hasSession(): boolean {
  return Boolean(sessionStorage.getItem(sessionKey));
}

export function clearSession(): void {
  sessionStorage.removeItem(sessionKey);
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem(sessionKey);
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    const fallback = response.status === 401
      ? "Your dashboard session has expired. Connect GitHub again to continue."
      : `Request failed (${response.status}).`;
    throw new ApiError(body.error || fallback, response.status);
  }
  return body as T;
}

export const gardenerApi = {
  health: () => api<HealthState>("/api/health"),
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
