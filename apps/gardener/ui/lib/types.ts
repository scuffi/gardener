import type { OperationKind } from "@gardener/contracts";

export type Flag = boolean | 0 | 1;
export type PolicyMode = "disabled" | "approval" | "automatic";
export type SetupProfile = "safe" | "review" | "labels";

export interface HealthState {
  ok: boolean;
  database: boolean;
  queue: boolean;
  workersAi: boolean;
  connectConfigured: boolean;
  localDevelopment: boolean;
  codeExecution?: { enabled: boolean; status: string; experimental: boolean };
}

export interface Viewer { login: string }
export interface SetupState { completed: boolean; profile?: SetupProfile | null; activeRepositories: number }
export interface Workflow {
  id: string;
  name: string;
  version: number;
  enabled: Flag;
  trigger_kind: string;
  updated_at?: string;
}
export interface Policy { operation_kind: string; mode: PolicyMode; updated_at?: string }
export interface Repository { id: string; owner: string; name: string; active: Flag; paused: boolean; updated_at?: string; default_branch?: string | null }
export interface Run {
  id: string;
  status: string;
  summary?: string | null;
  usage?: string | RunUsage | null;
  error?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  workflow_name: string;
  action: string;
  owner: string;
  name: string;
}
export interface RunUsage { model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number }
export interface Approval {
  id: string;
  run_id: string;
  operation_kind: string;
  policy_mode: PolicyMode;
  rationale: string;
  operation: string;
  created_at: string;
  summary?: string | null;
  event_kind: string;
  action: string;
  resource_id: string;
  owner: string;
  name: string;
}
export interface AuditRecord { actor: string; action: string; resource_type: string; resource_id: string; created_at: string }
export interface CapabilityState {
  issueGardening: string;
  pullRequestReview: string;
  computerCodeChanges: string;
  protectedMerge: string;
}
export interface AppState {
  globalPaused: boolean;
  viewer: Viewer;
  setup: SetupState;
  workflows: Workflow[];
  policies: Policy[];
  repositories: Repository[];
  runs: Run[];
  approvals: Approval[];
  audits: AuditRecord[];
  capabilities: CapabilityState;
}
export interface RunProposal {
  id: string;
  run_id: string;
  operation_kind: string;
  rationale: string;
  operation: string;
  status: string;
  receipt?: string | null;
  error?: string | null;
  created_at: string;
  decided_at?: string | null;
}
export interface RunDetail { run: Record<string, unknown>; proposals: RunProposal[] }

export const operationMetadata = {
  "issue.label.add": { name: "Add issue labels", description: "Add labels to issues." },
  "issue.label.remove": { name: "Remove issue labels", description: "Remove labels from issues." },
  "issue.comment.create": { name: "Post issue comments", description: "Post new comments on issues." },
  "issue.comment.update": { name: "Update issue comments", description: "Edit issue comments previously posted by Gardener." },
  "issue.close": { name: "Close issues", description: "Close open issues." },
  "issue.reopen": { name: "Reopen issues", description: "Reopen closed issues." },
  "branch.create": { name: "Create branches", description: "Create branches from a specific commit." },
  "commit.create": { name: "Create commits", description: "Create commits that add, update, or delete files on a branch." },
  "pull_request.open": { name: "Open pull requests", description: "Open draft or ready-for-review pull requests from a branch." },
  "pull_request.update": { name: "Update pull requests", description: "Edit titles, descriptions, or draft status, and close or reopen pull requests." },
  "pull_request.review.submit": { name: "Submit pull request reviews", description: "Submit review comments, approvals, or change requests." },
  "pull_request.merge": { name: "Merge pull requests", description: "Merge eligible pull requests using an allowed merge method." },
} satisfies Record<OperationKind, { name: string; description: string }>;
