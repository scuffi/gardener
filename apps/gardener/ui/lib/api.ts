import type {
  ActivatedAgent,
  ActivationInput,
  AddAgentAssignmentsInput,
  AddAllCurrentAgentAssignmentsInput,
  AgentDetailResponse,
  AgentSimulation,
  AgentSummary,
  AgentValidation,
  ActionsTaskRunSummary,
  AppState,
  AssignmentAuthorityInput,
  AssignmentListResponse,
  AssignmentMutationInput,
  AssignmentMutationResponse,
  HealthState,
  HistoryItem,
  InboxItem,
  OverlapConfirmationRequired,
  PolicyMode,
  PutRepositoryPolicyInput,
  RepositoryPolicyView,
  RunDetailResponse,
  RunSummary,
  SessionState,
  SetupProfile,
  TeamResponse,
} from "./types";

export class ApiError<T = unknown> extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: T,
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
export function parseSessionState(value: unknown): SessionState {
  if (!value || typeof value !== "object" || !("authenticated" in value)) {
    return { authenticated: false };
  }
  const session = value as Record<string, unknown>;
  if (session.authenticated !== true || typeof session.githubLogin !== "string") {
    return { authenticated: false };
  }
  if (!session.user || typeof session.user !== "object") return { authenticated: false };
  const user = session.user as Record<string, unknown>;
  if (
    typeof user.id !== "string" ||
    typeof user.displayName !== "string" ||
    (user.role !== "owner" && user.role !== "member") ||
    !user.identity ||
    typeof user.identity !== "object"
  ) {
    return { authenticated: false };
  }
  const identity = user.identity as Record<string, unknown>;
  if (
    (identity.provider !== "github" && identity.provider !== "cloudflare-access") ||
    typeof identity.providerSubject !== "string" ||
    typeof identity.login !== "string"
  ) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    githubLogin: session.githubLogin,
    user: {
      id: user.id,
      displayName: user.displayName,
      role: user.role,
      identity: {
        provider: identity.provider,
        providerSubject: identity.providerSubject,
        login: identity.login,
      },
    },
  };
}

export async function consumeReturnedIdentity(): Promise<boolean> {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const returned = hash.get("identity_token") ?? hash.get("token");
  if (!returned) return false;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  await api<unknown>("/api/auth/session", {
    method: "POST",
    body: JSON.stringify({ token: returned }),
  });
  return true;
}

const errorMessages: Record<string, string> = {
  already_a_member: "That GitHub user is already a member.",
  invitation_already_pending: "That GitHub user already has a pending invitation.",
  pending_invitation_not_found: "That pending invitation no longer exists.",
  member_not_found: "That member no longer belongs to this workspace.",
  owner_membership_permanent: "The permanent owner cannot be removed.",
  github_user_resolution_404: "No GitHub user was found with that username.",
  github_user_resolution_409: "GitHub could not resolve that username. Check it and try again.",
  github_user_resolution_429: "GitHub is receiving too many requests. Wait a moment and try again.",
  github_user_resolution_502: "GitHub could not be reached. Try again shortly.",
  github_user_resolution_503: "GitHub is temporarily unavailable. Try again shortly.",
};

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const fallback =
      response.status === 401
        ? "Your dashboard session has expired. Sign in again to continue."
        : `Request failed (${response.status}).`;
    const code = typeof body.error === "string" ? body.error : undefined;
    const backendMessage = typeof body.message === "string" ? body.message : undefined;
    const mappedMessage = code && Object.hasOwn(errorMessages, code)
      ? errorMessages[code]
      : undefined;
    const message = mappedMessage ?? backendMessage ?? fallback;
    throw new ApiError(message, response.status, code, body);
  }
  return body as T;
}

const json = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });
const put = (value: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(value) });
const remove = (): RequestInit => ({ method: "DELETE" });
const agentPath = (id: string) => `/api/agents/${encodeURIComponent(id)}`;
const assignmentPath = (id: string) => `/api/assignments/${encodeURIComponent(id)}`;

export function isOverlapConfirmationError(
  error: unknown,
): error is ApiError<OverlapConfirmationRequired> {
  return error instanceof ApiError && error.code === "overlap_confirmation_required";
}

export const gardenerApi = {
  health: () => api<HealthState>("/api/health"),
  session: async () => parseSessionState(await api<unknown>("/api/auth/session")),
  signOut: () => api<{ signedOut: true; accessLogoutUrl: string | null }>("/api/auth/logout", { method: "POST" }),
  state: () => api<AppState>("/api/state"),
  team: () => api<TeamResponse>("/api/members"),
  inviteMember: (githubUsername: string) =>
    api<{ invitation: { id: string; githubUsername: string; role: "member" } }>(
      "/api/invitations",
      json({ githubUsername }),
    ),
  revokeInvitation: (id: string) =>
    api<{ revoked: true }>(`/api/invitations/${encodeURIComponent(id)}`, remove()),
  removeMember: (id: string) =>
    api<{ removed: true }>(`/api/members/${encodeURIComponent(id)}`, remove()),

  beginInstallation: () =>
    api<{ requestId: string; installationUrl: string }>("/api/install/start", { method: "POST" }),
  finalizeInstallation: (requestId: string) =>
    api<{ installation: unknown; repositories: unknown[] }>(
      "/api/install/finalize",
      json({ requestId }),
    ),
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
  createAgent: (sourceMd: string) =>
    api<{ agent: AgentSummary; draftId: string }>("/api/agents", json({ sourceMd })),
  saveAgentDraft: (id: string, sourceMd: string) =>
    api<{ draftId: string; sourceHash: string }>(
      `${agentPath(id)}/draft`,
      put({ sourceMd }),
    ),
  validateAgent: (sourceMd: string, agentId?: string) =>
    api<AgentValidation>("/api/agents/validate", json({ sourceMd, agentId })),
  simulateAgent: (sourceMd: string, agentId?: string) =>
    api<AgentSimulation>("/api/agents/simulate", json({ sourceMd, agentId })),
  publishAgent: (id: string, sourceMd: string) =>
    api<{ revision: number; paused: true }>(
      `${agentPath(id)}/revisions`,
      json({ sourceMd }),
    ),
  activateAgentRevision: (id: string, revision: number) =>
    api<{ activated: true }>(`${agentPath(id)}/revisions/${revision}/activate`, {
      method: "POST",
    }),
  activateAgentRevisionWithPreconditions: (
    id: string,
    revisionId: string | number,
    input: ActivationInput,
  ) =>
    api<{ activated: true; agent: ActivatedAgent }>(
      `${agentPath(id)}/revisions/${encodeURIComponent(revisionId)}/activate`,
      json(input),
    ),
  agentAssignments: (id: string) =>
    api<AssignmentListResponse>(`${agentPath(id)}/assignments`),
  repositoryAssignments: (id: string) =>
    api<AssignmentListResponse>(`/api/repositories/${encodeURIComponent(id)}/assignments`),
  addAgentAssignments: (id: string, input: AddAgentAssignmentsInput) =>
    api<AssignmentListResponse & { materializedRepositoryCount: number }>(
      `${agentPath(id)}/assignments`,
      json(input),
    ),
  addAllCurrentAgentAssignments: (id: string, input: AddAllCurrentAgentAssignmentsInput) =>
    api<AssignmentListResponse & { materializedRepositoryCount: number }>(
      `${agentPath(id)}/assignments`,
      json({ ...input, allCurrent: true }),
    ),
  updateAssignmentState: (
    id: string,
    action: "enable" | "disable" | "remove" | "re-add",
    input: AssignmentMutationInput,
  ) =>
    api<AssignmentMutationResponse>(`${assignmentPath(id)}/${action}`, json(input)),
  updateAssignmentAuthority: (id: string, input: AssignmentAuthorityInput) =>
    api<AssignmentMutationResponse>(`${assignmentPath(id)}/authority`, put(input)),
  repositoryPolicy: (id: string) =>
    api<RepositoryPolicyView>(`/api/repositories/${encodeURIComponent(id)}/policy`),
  setRepositoryPolicy: (id: string, input: PutRepositoryPolicyInput) =>
    api<{ result: "updated" | "noop"; policy: RepositoryPolicyView }>(
      `/api/repositories/${encodeURIComponent(id)}/policy`,
      put(input),
    ),
  setAgentEnabled: (id: string, enabled: boolean) =>
    api<{ enabled: boolean }>(`${agentPath(id)}/status`, json({ enabled })),

  history: () => api<{ items: HistoryItem[] }>("/api/history"),

  actionsRuns: () => api<{ runs: ActionsTaskRunSummary[] }>("/api/actions/runs"),
  runs: (limit = 50) => api<{ runs: RunSummary[] }>(`/api/runs?limit=${limit}`),
  run: (id: string) => api<RunDetailResponse>(`/api/runs/${encodeURIComponent(id)}`),
};
