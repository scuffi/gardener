/**
 * Every TanStack Query key used by the dashboard.
 *
 * Keys live here so that invalidation is greppable and cannot drift between the component that
 * reads data and the mutation that invalidates it. Never inline a `queryKey` array in a feature.
 */
export const queryKeys = {
  health: ["health"] as const,
  session: (revision: number) => ["session", revision] as const,
  state: (revision?: number) =>
    (revision === undefined ? ["state"] : ["state", revision]) as readonly unknown[],
  inbox: ["inbox"] as const,
  history: ["history"] as const,
  team: ["team"] as const,
  agents: ["agents"] as const,
  agent: (id: string | undefined) => ["agent", id] as const,
  agentRevision: (id: string | undefined, revision: number | null) =>
    ["agent", id, "revision", revision] as const,
  agentAssignments: (id: string | undefined) => ["agent", id, "assignments"] as const,
  repositoryAssignments: (id: string | undefined) =>
    ["repository", id, "assignments"] as const,
  repositoryPolicy: (id: string | undefined) => ["repository", id, "policy"] as const,
  runs: ["runs"] as const,
  actionsTaskRuns: ["actions-task-runs"] as const,
  run: (id: string | undefined) => ["run", id] as const,
} as const;

/** Broad prefixes for invalidation after a mutation. */
export const queryPrefixes = {
  state: ["state"] as const,
  agents: ["agents"] as const,
  agent: ["agent"] as const,
  inbox: ["inbox"] as const,
  repositories: ["repository"] as const,
  runs: ["runs"] as const,
} as const;
