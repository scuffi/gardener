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
export interface Repository { id: string; owner: string; name: string; active: Flag; updated_at?: string; default_branch?: string | null }
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

export const operationMetadata: Record<string, { name: string; description: string; risk: "low" | "medium" | "high" }> = {
  "issue.label.add": { name: "Add labels", description: "Apply a conventional label to an issue.", risk: "low" },
  "issue.label.remove": { name: "Remove labels", description: "Remove a label that no longer applies.", risk: "low" },
  "issue.comment.create": { name: "Post comments", description: "Publish a bounded reply on an issue.", risk: "medium" },
  "issue.comment.update": { name: "Update comments", description: "Edit a comment previously created by Gardener.", risk: "medium" },
  "issue.close": { name: "Close issues", description: "Change an open issue to closed.", risk: "high" },
  "issue.reopen": { name: "Reopen issues", description: "Return a closed issue to open.", risk: "high" },
};
