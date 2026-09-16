export type Flag = boolean | 0 | 1;
export type PolicyMode = "disabled" | "approval" | "automatic";
export type SetupProfile = "safe" | "review" | "labels";
export type WorkspaceRole = "owner" | "member";

export interface GitHubIdentity {
  provider: "github";
  providerSubject: string;
  login: string;
}

export interface LocalIdentity {
  provider: "local";
  providerSubject: "local-development";
  login: "local-developer";
}

export interface SessionUser {
  id: string;
  displayName: string;
  role: WorkspaceRole;
  identity: GitHubIdentity | LocalIdentity;
}

export type SessionState =
  | { authenticated: false }
  | { authenticated: true; githubLogin: string; user: SessionUser };

export interface TeamMember {
  id: string;
  display_name: string;
  role: WorkspaceRole;
  permanent: number;
  username: string;
  provider_subject: string;
}

export interface TeamInvitation {
  id: string;
  username: string;
  provider_subject: string;
  created_at: string;
  expires_at: string;
}

export interface TeamResponse {
  members: TeamMember[];
  invitations: TeamInvitation[];
}

export interface AgentRepositoryAssignment {
  schemaVersion: "v1";
  id: string;
  version: number;
  configHash: string;
  agentId: string;
  agentDisplayName?: string;
  repositoryId: string;
  repositoryDisplayName?: string;
  enabled: boolean;
  authorityCeiling: PolicyMode;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
}

export interface AssignmentListResponse {
  assignmentEpoch: number;
  assignments: AgentRepositoryAssignment[];
}

interface AddAgentAssignmentsBase {
  authorityCeiling: PolicyMode;
  expectedAssignmentEpoch: number;
  expectedVersion?: number;
  expectedConfigHash?: string;
  expectedActiveRevisionId?: string | null;
  materializedRepositoryIds?: string[];
  overlapFingerprint?: string;
}

export interface AddSingleAgentAssignmentInput extends AddAgentAssignmentsBase {
  repositoryId: string;
  allCurrent?: never;
}

export interface AddAllCurrentAgentAssignmentsRequest extends AddAgentAssignmentsBase {
  repositoryId?: never;
  allCurrent: true;
}

export type AddAgentAssignmentsInput =
  | AddSingleAgentAssignmentInput
  | AddAllCurrentAgentAssignmentsRequest;

export type AddAllCurrentAgentAssignmentsInput = Omit<
  AddAllCurrentAgentAssignmentsRequest,
  "allCurrent"
>;

export interface AssignmentMutationInput {
  expectedVersion: number;
  expectedConfigHash: string;
  expectedAssignmentEpoch: number;
  authorityCeiling?: PolicyMode;
  reason?: string | null;
  expectedActiveRevisionId?: string | null;
  overlapFingerprint?: string;
}

export interface AssignmentAuthorityInput {
  authorityCeiling: PolicyMode;
  expectedVersion: number;
  expectedConfigHash: string;
  expectedAssignmentEpoch: number;
  reason?: string | null;
}

export interface AssignmentMutationResponse {
  assignment: AgentRepositoryAssignment;
  assignmentEpoch: number;
  result: "updated" | "noop";
}

export interface AssignmentOverlapConflict {
  assignmentId: string;
  assignmentVersion: number;
  agentId: string;
  agentDisplayName?: string;
  activeRevisionId: string;
  activeRevisionCompiledHash: string;
  sharedTriggers: string[];
  sharedEffects: string[];
}

export interface AssignmentOverlapWarning {
  schemaVersion: "v1";
  assignmentEpoch: number;
  repositoryId: string;
  repositoryDisplayName?: string;
  candidate: {
    agentId: string;
    revisionId: string;
    revisionCompiledHash: string;
    assignmentId: string;
    assignmentVersion: number;
  };
  conflicts: AssignmentOverlapConflict[];
  fingerprint: string;
  currentActiveRevisionId?: string | null;
}

export interface AssignmentPrecondition {
  repositoryId: string;
  assignmentId: string;
  expectedVersion: number | null;
  expectedConfigHash: string | null;
}

export interface AggregateOverlapWarning {
  schemaVersion?: "v1";
  assignmentEpoch: number;
  agent?: { id: string; name?: string };
  repositories: AssignmentOverlapWarning[];
  preconditions?: AssignmentPrecondition[];
  materializedRepositoryIds?: string[];
  fingerprint: string;
  currentActiveRevisionId?: string | null;
}

export interface OverlapConfirmationRequired {
  error: "overlap_confirmation_required";
  warning: AssignmentOverlapWarning | AggregateOverlapWarning;
}

export interface ActivationInput {
  reason?: string | null;
  expectedAssignmentEpoch: number;
  expectedCurrentRevisionId: string | null;
  overlapFingerprint?: string;
}

export interface ActivatedAgent {
  id: string;
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  revisionCounter: number;
  activeRevisionId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  enabledAssignments: number;
  assignmentCount: number;
}

export type ObservationCapability =
  | "github.repository.metadata.read"
  | "github.issue.read"
  | "github.pull_request.read"
  | "github.comment.read"
  | "github.review.read"
  | "github.discussion.read"
  | "github.check.read"
  | "github.contents.read"
  | "github.commit.read"
  | "github.release.read";

export type WorkspaceCapability =
  | "workspace.fs.read"
  | "workspace.fs.write"
  | "workspace.git.read"
  | "workspace.git.write-local"
  | "workspace.exec.shell"
  | "workspace.exec.javascript"
  | "workspace.exec.container"
  | "workspace.network.connect"
  | "workspace.dependencies.install"
  | "workspace.artifacts.publish";

export type OperationKind = keyof typeof operationMetadataValues;

export interface RepositoryPolicy {
  schemaVersion: "v1";
  repositoryId: string;
  repositoryDisplayName?: string;
  version: number;
  policyHash: string;
  operationModes: Partial<Record<OperationKind, PolicyMode>>;
  allowedObservations: ObservationCapability[];
  workspaceModes: Partial<Record<WorkspaceCapability, PolicyMode>>;
}

export interface RepositoryPolicyView {
  configured: boolean;
  message?: string;
  repository: { id: string; name: string; active: boolean };
  policy: RepositoryPolicy;
  policyVersion: number;
  policyHash: string;
  repositoryConstraints: Record<string, unknown>;
  workspaceCeilings: {
    operationModes: Record<string, PolicyMode>;
    observation: Record<string, PolicyMode>;
    workspaceModes: Record<string, PolicyMode>;
    constraints: Record<string, unknown>;
  };
  effective: {
    operationModes: Record<string, PolicyMode>;
    allowedObservations: string[];
    workspaceModes: Record<string, PolicyMode>;
  };
}

export interface PutRepositoryPolicyInput {
  expectedPolicyVersion: number;
  expectedPolicyHash: string | null;
  operationModes: Record<OperationKind, PolicyMode>;
  allowedObservations: ObservationCapability[];
  workspaceModes: Record<WorkspaceCapability, PolicyMode>;
}

export interface HealthState {
  ok: boolean;
  database: boolean;
  durableOrchestration?: boolean;
  workersAi: boolean;
  githubGateway: { configured: boolean; ready: boolean };
  localDevelopment: boolean;
  computer?: boolean | { configured: boolean; experimental: boolean };
  artifactStorage?: boolean;
  agentRuntime: { enabled: boolean; status: string };
  oauthMcp?: boolean | { configured: boolean; route: string };
}

export interface Viewer { login: string }
export interface SetupState { completed: boolean; profile?: SetupProfile | null; activeRepositories: number }
export interface Policy { operation_kind: string; mode: PolicyMode; updated_at?: string }
export interface Repository {
  id: string;
  owner: string;
  name: string;
  active: Flag;
  paused: boolean;
  updated_at?: string;
  default_branch?: string | null;
}
export interface RunUsage { model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number }

/**
 * Run observability.
 *
 * Field names are snake_case because these rows are returned straight from D1 by
 * `GET /api/runs` and `GET /api/runs/:id`. Do not camelCase them in the UI — the wire shape is
 * the contract, and renaming here only hides where the data came from.
 */
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled";

export interface RunSummary {
  id: string;
  kind: string;
  agent_id: string | null;
  agent_revision_id?: string | null;
  status: RunStatus | string;
  harness_id?: string | null;
  harness_version?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

/** A unit of work in the run graph. `parent_task_id` and `depth` describe the tree. */
export interface RunTask {
  id: string;
  parent_task_id: string | null;
  stable_key: string;
  kind: string;
  status: string;
  /** Tasks sharing a group ran concurrently. */
  parallel_group: string | null;
  depth: number;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface RunStep {
  id: string;
  task_id: string;
  stable_key: string;
  kind: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

/** A side effect on GitHub, gated by policy. This is the receipt an operator audits. */
export interface RunEffect {
  id: string;
  operation_id: string;
  effect_kind: string;
  policy_mode: PolicyMode | string;
  status: string;
  created_at: string;
  decided_at?: string | null;
  executed_at?: string | null;
}

export interface RunDetailResponse {
  run: RunSummary & Record<string, unknown>;
  tasks: RunTask[];
  steps: RunStep[];
  effects: RunEffect[];
}
export interface CapabilityState { [name: string]: string }
export interface AppState {
  globalPaused: boolean;
  viewer: Viewer;
  setup: SetupState;
  policies: Policy[];
  repositories: Repository[];
  capabilities?: CapabilityState;
  inboxCount?: number;
  /** Most recent runs, newest first. Served inline by `/api/state`. */
  runs?: RunSummary[];
}

export type AgentLifecycle = "draft" | "paused" | "active";
export interface AgentSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  lifecycle: AgentLifecycle;
  activeRevision: number | null;
  latestRevision: number | null;
  hasDraft: boolean;
  updatedAt: string;
}
export interface AgentRevisionSummary {
  id: string;
  revision: number;
  sourceHash: string;
  compiledHash?: string;
  publishedAt: string;
  publishedBy?: string;
  active: boolean;
}
export interface AgentDraft {
  id: string;
  sourceMd: string;
  sourceHash?: string;
  updatedAt?: string;
  thisRepositoryId?: string;
}
export interface AgentDetailResponse {
  agent: AgentSummary;
  draft: AgentDraft | null;
  /** Latest immutable source used only to seed a new mutable draft. */
  sourceMd?: string;
  thisRepositoryId?: string;
  revisions: AgentRevisionSummary[];
  assignments: AgentRepositoryAssignment[];
}
export interface AgentValidationDiagnostic {
  code: string;
  path?: string;
  message: string;
  severity?: "error" | "warning";
}
export interface AgentCapabilityReview {
  observation: string[];
  workspace: Array<string | { capability: string; mode?: PolicyMode }>;
  effects: Array<string | { capability: string; mode?: PolicyMode }>;
}
export interface AgentValidation {
  valid: boolean;
  publishable?: boolean;
  diagnostics: AgentValidationDiagnostic[];
  capabilities?: AgentCapabilityReview;
}
export interface AgentSimulation {
  status: "completed" | "blocked" | "failed";
  summary: string;
  proposedEffects?: Array<{ kind: string; summary?: string }>;
  diagnostics?: AgentValidationDiagnostic[];
}

export type InboxItemKind =
  | "interruption"
  | "effect"
  | "failed_run"
  | "draft_activation"
  | "eval_regression"
  | "workspace_cleanup";
export interface InboxItem {
  id: string;
  kind: InboxItemKind;
  status: "open" | "resolved" | "dismissed";
  priority: "low" | "normal" | "high" | "urgent";
  title: string;
  summary: string;
  runId?: string | null;
  createdAt: string;
  expiresAt?: string | null;
  actions?: Array<"approve" | "reject" | "dismiss">;
}
export interface HistoryItem {
  id: string;
  kind: "run" | "decision" | "revision" | "agent" | "policy" | "system";
  title: string;
  summary?: string;
  status?: string;
  actor?: string;
  agentId?: string;
  runId?: string;
  createdAt: string;
}

const operationMetadataValues = {
  "issue.label.add": { name: "Add issue labels", description: "Add labels to issues." },
  "issue.label.remove": { name: "Remove issue labels", description: "Remove labels from issues." },
  "issue.comment.create": { name: "Post issue comments", description: "Post comments on issues." },
  "issue.comment.update": {
    name: "Update issue comments",
    description: "Edit comments previously posted by Gardener.",
  },
  "issue.close": { name: "Close issues", description: "Close open issues." },
  "issue.reopen": { name: "Reopen issues", description: "Reopen closed issues." },
  "issue.assignee.add": { name: "Add issue assignees", description: "Assign people to issues." },
  "issue.assignee.remove": { name: "Remove issue assignees", description: "Remove people from issues." },
  "pull_request.comment.create": { name: "Comment on pull requests", description: "Post pull request comments." },
  "pull_request.comment.update": {
    name: "Update pull request comments",
    description: "Edit Gardener pull request comments.",
  },
  "pull_request.review.submit": { name: "Submit reviews", description: "Submit bounded pull request reviews." },
  "pull_request.reviewer.request": { name: "Request reviewers", description: "Request pull request reviewers." },
  "pull_request.reviewer.remove": { name: "Remove reviewers", description: "Remove requested reviewers." },
  "pull_request.update": { name: "Update pull requests", description: "Update pull request metadata or state." },
  "branch.create": { name: "Create branches", description: "Create a Gardener branch at an exact commit." },
  "commit.create": { name: "Create commits", description: "Commit bounded file changes." },
  "pull_request.open_draft": {
    name: "Open draft pull requests",
    description: "Open a draft pull request from a Gardener branch.",
  },
  "pull_request.merge": {
    name: "Merge pull requests",
    description: "Merge an eligible pull request after live revalidation.",
  },
  "discussion.comment.create": { name: "Comment on discussions", description: "Post discussion comments." },
  "discussion.comment.update": {
    name: "Update discussion comments",
    description: "Edit Gardener discussion comments.",
  },
  "discussion.answer.mark": {
    name: "Mark discussion answers",
    description: "Mark a discussion comment as the answer.",
  },
  "discussion.answer.unmark": { name: "Unmark discussion answers", description: "Remove a discussion answer." },
  "discussion.close": { name: "Close discussions", description: "Close discussions." },
  "discussion.reopen": { name: "Reopen discussions", description: "Reopen discussions." },
  "check.rerun": { name: "Rerun checks", description: "Rerun completed check runs." },
  "release.create": { name: "Create draft releases", description: "Create draft releases." },
  "release.update": { name: "Update releases", description: "Update release metadata." },
  "release.publish": { name: "Publish releases", description: "Publish an exact draft release." },
  "release.delete": { name: "Delete releases", description: "Delete a release after live revalidation." },
} satisfies Record<string, { name: string; description: string }>;

export const operationMetadata: Record<string, { name: string; description: string }> =
  operationMetadataValues;
