import type {
  AgentDetailResponse,
  AgentSimulation,
  AgentSummary,
  AgentValidation,
  AppState,
  HealthState,
  HistoryItem,
  InboxItem,
  PolicyMode,
  SetupProfile,
} from "./types";

export interface SessionState {
  authenticated: boolean;
  githubLogin?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Exchange an identity token handed back in the URL fragment for a dashboard session cookie.
 *
 * The fragment is cleared before the request so the token never lands in history or a referrer.
 */
export async function consumeReturnedIdentity(): Promise<boolean> {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const returned = hash.get("identity_token") ?? hash.get("token");
  if (!returned) return false;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  await api<SessionState>("/api/auth/session", {
    method: "POST",
    body: JSON.stringify({ token: returned }),
  });
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
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    const fallback =
      response.status === 401
        ? "Your dashboard session has expired. Sign in again to continue."
        : `Request failed (${response.status}).`;
    throw new ApiError(body.error || fallback, response.status);
  }
  return body as T;
}

const json = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });
const put = (value: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(value) });
const agentPath = (id: string) => `/api/agents/${encodeURIComponent(id)}`;

export const gardenerApi = {
  health: () => api<HealthState>("/api/health"),
  session: () => api<SessionState>("/api/auth/session"),
  signOut: () => api<{ signedOut: true }>("/api/auth/logout", { method: "POST" }),
  state: () => api<AppState>("/api/state"),

  beginInstallation: () =>
    api<{ installationUrl: string }>("/api/install/start", { method: "POST" }),
  syncRepositories: () =>
    api<{ repositories: unknown[] }>("/api/repositories/sync", { method: "POST" }),
  activate: (profile: SetupProfile) =>
    api<{ activated: true; profile: SetupProfile }>("/api/setup/activate", json({ profile })),

  setPaused: (paused: boolean) =>
    api<{ globalPaused: boolean }>("/api/settings/pause", json({ paused })),
  setRepositoryPaused: (id: string, paused: boolean) =>
    api<{ id: string; paused: boolean }>(
      `/api/repositories/${encodeURIComponent(id)}/pause`,
      put({ paused }),
    ),
  setPolicies: (policies: Array<{ operation: string; mode: PolicyMode }>) =>
    api<{ policies: Array<{ operation: string; mode: PolicyMode }> }>(
      "/api/policies",
      put({ policies }),
    ),

  inbox: () => api<{ items: InboxItem[] }>("/api/inbox"),
  respondToInbox: (id: string, action: "approve" | "reject" | "dismiss") =>
    api<{ item: InboxItem }>(`/api/inbox/${encodeURIComponent(id)}/respond`, json({ action })),

  agents: () => api<{ agents: AgentSummary[] }>("/api/agents"),
  agent: (id: string) => api<AgentDetailResponse>(agentPath(id)),
  agentRevision: (id: string, revision: number) =>
    api<{ revision: number; sourceMd: string; sourceHash: string; compiledHash?: string }>(
      `${agentPath(id)}/revisions/${revision}`,
    ),
  createAgent: (sourceMd: string, thisRepositoryId?: string) =>
    api<{ agent: AgentSummary; draftId: string }>(
      "/api/agents",
      json({ sourceMd, thisRepositoryId }),
    ),
  saveAgentDraft: (id: string, sourceMd: string, thisRepositoryId?: string) =>
    api<{ draftId: string; sourceHash: string }>(
      `${agentPath(id)}/draft`,
      put({ sourceMd, thisRepositoryId }),
    ),
  validateAgent: (sourceMd: string, agentId?: string, thisRepositoryId?: string) =>
    api<AgentValidation>("/api/agents/validate", json({ sourceMd, agentId, thisRepositoryId })),
  simulateAgent: (sourceMd: string, agentId?: string, thisRepositoryId?: string) =>
    api<AgentSimulation>("/api/agents/simulate", json({ sourceMd, agentId, thisRepositoryId })),
  publishAgent: (id: string, sourceMd: string, thisRepositoryId?: string) =>
    api<{ revision: number; paused: true }>(
      `${agentPath(id)}/revisions`,
      json({ sourceMd, thisRepositoryId }),
    ),
  activateAgentRevision: (id: string, revision: number) =>
    api<{ activated: true }>(`${agentPath(id)}/revisions/${revision}/activate`, {
      method: "POST",
    }),
  setAgentEnabled: (id: string, enabled: boolean) =>
    api<{ enabled: boolean }>(`${agentPath(id)}/status`, json({ enabled })),

  history: () => api<{ items: HistoryItem[] }>("/api/history"),
};
