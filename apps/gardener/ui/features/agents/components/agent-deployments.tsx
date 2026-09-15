import {
  ArrowsClockwiseIcon,
  PlusIcon,
  PowerIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useGardener } from "../../../app-context";
import {
  ApiError,
  gardenerApi,
  isOverlapConfirmationError,
} from "../../../lib/api";
import { queryKeys } from "../../../lib/query-keys";
import type {
  AgentRepositoryAssignment,
  AgentRevisionSummary,
  AgentSummary,
  AggregateOverlapWarning,
  AssignmentOverlapWarning,
  PolicyMode,
  Repository,
} from "../../../lib/types";
import { useNotifications } from "../../../providers/notifications";
import {
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Panel,
  PanelHeader,
  Select,
  StatusBadge,
  Table,
  TableSkeleton,
  statusTone,
} from "../../../primitives";

type Warning = AssignmentOverlapWarning | AggregateOverlapWarning;
type AssignmentAction = "enable" | "disable" | "remove" | "re-add";
type GuardedAction =
  | { kind: "add"; repository: Repository; ceiling: PolicyMode }
  | { kind: "all"; repositories: Repository[]; ceiling: PolicyMode }
  | { kind: AssignmentAction; assignment: AgentRepositoryAssignment; repositoryName: string }
  | {
      kind: "authority";
      assignment: AgentRepositoryAssignment;
      repositoryName: string;
      ceiling: PolicyMode;
    };
type AddIntent = "single" | "all";
type OverlapState = { warning: Warning; retry: () => Promise<void> };

const modeRank: Record<PolicyMode, number> = {
  disabled: 0,
  approval: 1,
  automatic: 2,
};

function repositoryName(repository: Repository | undefined, fallback?: string) {
  return repository ? `${repository.owner}/${repository.name}` : fallback ?? "Unknown repository";
}

function effectiveSummary(assignment: AgentRepositoryAssignment) {
  if (assignment.removedAt) return "Removed; no runtime authority";
  if (!assignment.enabled) return "Disabled; no runtime authority";
  if (assignment.authorityCeiling === "disabled") return "Enabled; effects disabled";
  if (assignment.authorityCeiling === "approval") return "Enabled; approval ceiling";
  return "Enabled; automatic ceiling, still bounded by repository policy";
}

function warningRepositories(warning: Warning) {
  return "repositories" in warning ? warning.repositories : [warning];
}

export function AgentDeployments({
  agent,
  revisions,
}: {
  agent: AgentSummary;
  revisions: AgentRevisionSummary[];
}) {
  const { state, stateLoading, error: stateError, session } = useGardener();
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const owner = session.authenticated && session.user.role === "owner";
  const currentRepositories = (state?.repositories ?? []).filter((item) => Boolean(item.active));
  const assignments = useQuery({
    queryKey: queryKeys.agentAssignments(agent.id),
    queryFn: () => gardenerApi.agentAssignments(agent.id),
  });
  const [repositoryId, setRepositoryId] = useState("");
  const [newCeiling, setNewCeiling] = useState<PolicyMode>("approval");
  const [mutationPending, setMutationPending] = useState(false);
  const mutationPendingRef = useRef(false);
  const [guarded, setGuarded] = useState<GuardedAction | null>(null);
  const guardedRef = useRef<GuardedAction | null>(null);
  guardedRef.current = guarded;
  const lastGuarded = useRef<GuardedAction | null>(null);
  const [overlap, setOverlap] = useState<OverlapState | null>(null);
  const overlapRef = useRef<OverlapState | null>(null);
  overlapRef.current = overlap;
  const lastOverlap = useRef<OverlapState | null>(null);
  if (guarded) lastGuarded.current = guarded;
  if (overlap) lastOverlap.current = overlap;
  const renderedGuarded = guarded ?? lastGuarded.current;
  const renderedOverlap = overlap ?? lastOverlap.current;
  const rows = assignments.data?.assignments ?? [];
  const currentIds = new Set(currentRepositories.map((item) => item.id));
  const currentAssigned = new Set(
    rows
      .filter((item) => !item.removedAt && currentIds.has(item.repositoryId))
      .map((item) => item.repositoryId),
  );
  const existingIds = new Set(rows.map((item) => item.repositoryId));
  const removedCurrent = rows.filter(
    (item) => Boolean(item.removedAt) && currentIds.has(item.repositoryId),
  );
  const available = currentRepositories.filter((item) => !existingIds.has(item.id));
  const activeRevisionId = revisions.find((item) => item.active)?.id ?? null;

  const invalidate = async (repositoryIds: string[]) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.agentAssignments(agent.id), exact: true }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agent(agent.id), exact: true }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agents, exact: true }),
      ...repositoryIds.map((id) =>
        queryClient.invalidateQueries({ queryKey: queryKeys.repositoryAssignments(id), exact: true }),
      ),
    ]);
  };

  const assignmentErrorDescription = (error: unknown) => {
    if (error instanceof ApiError) {
      const messages: Record<string, string> = {
        assignment_changed: "The deployment changed. Fresh assignment data has been loaded.",
        assignment_removed: "This deployment was removed. Use Re-add to restore it.",
        use_assignment_authority_endpoint:
          "The deployment state changed. Adjust its authority ceiling separately.",
        active_repository_not_found: "That repository is no longer active or available.",
        assignment_expansion_too_large:
          "There are too many current repositories to assign in one operation.",
      };
      const mapped = error.code ? messages[error.code] : undefined;
      if (mapped) return mapped;
      if (error.status === 409) {
        return "Deployment state is stale. Fresh assignment data has been loaded.";
      }
    }
    return error instanceof Error ? error.message : "The request failed.";
  };

  const reportError = (error: unknown, title: string) => {
    notify({ tone: "error", title, description: assignmentErrorDescription(error) });
  };

  const refreshAfterFailure = async () => {
    await assignments.refetch();
  };

  const runOnce = async (operation: () => Promise<void>) => {
    if (mutationPendingRef.current) return;
    mutationPendingRef.current = true;
    setMutationPending(true);
    try {
      await operation();
    } finally {
      mutationPendingRef.current = false;
      setMutationPending(false);
    }
  };

  const finish = async (
    result: unknown,
    repositoryIds: string[],
    successTitle: string,
  ) => {
    await invalidate(repositoryIds);
    setGuarded(null);
    setOverlap(null);
    const noop = Boolean(
      result && typeof result === "object" && "result" in result && result.result === "noop",
    );
    if (noop) {
      notify({
        tone: "info",
        title: "No changes needed",
        description: "The deployment already matched the requested state.",
      });
      return;
    }
    notify({ tone: "success", title: successTitle });
  };

  const runAdd = async (
    intent: AddIntent,
    repositories: Repository[],
    ceiling: PolicyMode,
    warning?: Warning,
  ): Promise<void> => {
    const single = repositories[0];
    const aggregate = warning && "repositories" in warning ? warning : undefined;
    const precondition = aggregate?.preconditions?.find((item) => item.repositoryId === single?.id);
    const materializedRepositoryIds =
      aggregate?.materializedRepositoryIds ?? repositories.map((item) => item.id);
    const input = {
      authorityCeiling: ceiling,
      expectedAssignmentEpoch: warning?.assignmentEpoch ?? assignments.data!.assignmentEpoch,
      expectedActiveRevisionId:
        warning && "currentActiveRevisionId" in warning
          ? warning.currentActiveRevisionId ?? null
          : activeRevisionId,
      ...(intent === "all" || warning ? { materializedRepositoryIds } : {}),
      ...(warning ? { overlapFingerprint: warning.fingerprint } : {}),
      ...(precondition?.expectedVersion ? { expectedVersion: precondition.expectedVersion } : {}),
      ...(precondition?.expectedConfigHash
        ? { expectedConfigHash: precondition.expectedConfigHash }
        : {}),
    };
    try {
      const result = intent === "all"
        ? await gardenerApi.addAllCurrentAgentAssignments(agent.id, input)
        : await gardenerApi.addAgentAssignments(agent.id, { ...input, repositoryId: single!.id });
      const missingCount = available.length;
      const successTitle = intent === "all"
        ? `${result.materializedRepositoryCount} current repositories materialized; ` +
          `${missingCount} missing ${missingCount === 1 ? "deployment" : "deployments"} added`
        : "Repository assigned";
      await finish(result, repositories.map((item) => item.id), successTitle);
    } catch (error) {
      await refreshAfterFailure();
      if (isOverlapConfirmationError(error)) {
        const fresh = error.details!.warning;
        setGuarded(null);
        setOverlap({
          warning: fresh,
          retry: () => runOnce(() => runAdd(intent, repositories, ceiling, fresh)),
        });
        return;
      }
      setGuarded(null);
      setOverlap(null);
      reportError(
        error,
        intent === "single" ? "Repository was not assigned" : "Repositories were not assigned",
      );
    }
  };

  const runAssignment = async (
    assignment: AgentRepositoryAssignment,
    action: AssignmentAction,
    warning?: Warning,
  ): Promise<void> => {
    try {
      const result = await gardenerApi.updateAssignmentState(assignment.id, action, {
        expectedVersion: assignment.version,
        expectedConfigHash: assignment.configHash,
        expectedAssignmentEpoch: warning?.assignmentEpoch ?? assignments.data!.assignmentEpoch,
        reason: null,
        expectedActiveRevisionId:
          warning && "currentActiveRevisionId" in warning
            ? warning.currentActiveRevisionId ?? null
            : activeRevisionId,
        ...(action === "re-add" ? { authorityCeiling: assignment.authorityCeiling } : {}),
        ...(warning ? { overlapFingerprint: warning.fingerprint } : {}),
      });
      await finish(result, [assignment.repositoryId], `Deployment ${action === "re-add" ? "re-added" : `${action}d`}`);
    } catch (error) {
      await refreshAfterFailure();
      if (isOverlapConfirmationError(error)) {
        const fresh = error.details!.warning;
        setGuarded(null);
        setOverlap({
          warning: fresh,
          retry: () => runOnce(() => runAssignment(assignment, action, fresh)),
        });
        return;
      }
      setGuarded(null);
      setOverlap(null);
      reportError(error, "Deployment was not changed");
    }
  };

  const runAuthority = async (
    assignment: AgentRepositoryAssignment,
    ceiling: PolicyMode,
  ) => {
    try {
      const result = await gardenerApi.updateAssignmentAuthority(assignment.id, {
        authorityCeiling: ceiling,
        expectedVersion: assignment.version,
        expectedConfigHash: assignment.configHash,
        expectedAssignmentEpoch: assignments.data!.assignmentEpoch,
        reason: null,
      });
      await finish(result, [assignment.repositoryId], "Authority ceiling updated");
    } catch (error) {
      await refreshAfterFailure();
      setGuarded(null);
      reportError(error, "Authority ceiling was not changed");
    }
  };

  const confirmGuarded = () => {
    const action = guardedRef.current;
    if (!action) return;
    if (action.kind === "add") {
      return runOnce(() => runAdd("single", [action.repository], action.ceiling));
    }
    if (action.kind === "all") {
      return runOnce(() => runAdd("all", action.repositories, action.ceiling));
    }
    if (action.kind === "authority") {
      return runOnce(() => runAuthority(action.assignment, action.ceiling));
    }
    return runOnce(() => runAssignment(action.assignment, action.kind));
  };

  const summary = !state
    ? stateLoading
      ? "Current repository list is loading"
      : stateError
        ? "Current repository list is unavailable because it failed to load"
        : "Current repository list is unavailable"
    : !currentRepositories.length || !currentAssigned.size
      ? "None"
      : currentAssigned.size === currentRepositories.length
        ? "All current"
        : `Some (${currentAssigned.size} of ${currentRepositories.length} current)`;

  const assignmentBoundary = !state
    ? "Assignment controls are unavailable until the current repository list loads."
    : removedCurrent.length
      ? "Assign all current is disabled until removed deployments are re-added individually."
      : !available.length
        ? "Assign all current is disabled because no current repositories are missing."
        : `Assign all current adds only ${available.length} missing ${
            available.length === 1 ? "deployment" : "deployments"
          }.`;

  const guardedRepository = renderedGuarded && "repositoryName" in renderedGuarded
    ? renderedGuarded.repositoryName
    : renderedGuarded?.kind === "add"
      ? repositoryName(renderedGuarded.repository)
      : null;
  const guardedTitle = renderedGuarded?.kind === "all"
    ? `Assign ${agent.name} to all current repositories?`
    : renderedGuarded?.kind === "add"
      ? `Add ${agent.name} to ${repositoryName(renderedGuarded.repository)}?`
      : renderedGuarded?.kind === "remove"
        ? `Remove ${agent.name} from ${guardedRepository}?`
        : renderedGuarded?.kind === "enable"
          ? `Enable ${agent.name} on ${guardedRepository}?`
          : renderedGuarded?.kind === "re-add"
            ? `Re-add ${agent.name} to ${guardedRepository}?`
            : `Widen ${agent.name} authority on ${guardedRepository}?`;

  return (
    <Panel padded={false} className="mb-4">
      <PanelHeader
        title="Repositories / Deployments"
        description={
          `${summary}. ${assignmentBoundary} The exact current set is materialized now; ` +
          "future repositories are not included."
        }
        actions={owner && state && assignments.data && currentRepositories.length ? (
          <Button
            className="max-md:min-h-11 max-md:min-w-11"
            variant="secondary"
            icon={ArrowsClockwiseIcon}
            disabled={!available.length || Boolean(removedCurrent.length)}
            onClick={() =>
              setGuarded({
                kind: "all",
                repositories: currentRepositories,
                ceiling: newCeiling,
              })
            }
          >
            Assign all current
          </Button>
        ) : null}
      />
      {assignments.isLoading ? (
        <TableSkeleton rows={3} columns={4} />
      ) : assignments.error ? (
        <div className="p-4">
          <ErrorState
            message={(assignments.error as Error).message}
            onRetry={() => void assignments.refetch()}
          />
        </div>
      ) : (
        <>
          {owner && state && available.length ? (
            <div
              className={
                "grid grid-cols-[minmax(0,1fr)_160px_auto] gap-2 border-b " +
                "border-kumo-hairline p-4 max-sm:grid-cols-1"
              }
            >
              <Select
                className="max-md:min-h-11 max-md:min-w-11"
                label="Repository"
                hideLabel={false}
                value={repositoryId}
                onValueChange={(value) => setRepositoryId(value ?? "")}
              >
                <Select.Option value="">Choose a repository</Select.Option>
                {available.map((repository) => (
                  <Select.Option key={repository.id} value={repository.id}>
                    {repositoryName(repository)}
                  </Select.Option>
                ))}
              </Select>
              <Select
                className="max-md:min-h-11 max-md:min-w-11"
                label="Authority ceiling"
                hideLabel={false}
                value={newCeiling}
                onValueChange={(value) => setNewCeiling((value ?? "approval") as PolicyMode)}
              >
                <Select.Option value="disabled">Disabled</Select.Option>
                <Select.Option value="approval">Approval</Select.Option>
                <Select.Option value="automatic">Automatic</Select.Option>
              </Select>
              <Button
                className="max-md:min-h-11 max-md:min-w-11"
                variant="primary"
                icon={PlusIcon}
                disabled={!repositoryId}
                onClick={() => {
                  const repository = available.find((item) => item.id === repositoryId);
                  if (repository) setGuarded({ kind: "add", repository, ceiling: newCeiling });
                }}
              >
                Add repository
              </Button>
            </div>
          ) : null}
          {rows.length ? (
            <>
            <div
              className="hidden overflow-x-auto md:block"
              data-testid="deployment-desktop-table"
            >
              <Table className="min-w-[760px] text-sm">
                <Table.Header variant="compact">
                  <Table.Row>
                    <Table.Head>Repository</Table.Head>
                    <Table.Head>Status / effective authority</Table.Head>
                    <Table.Head>Authority ceiling</Table.Head>
                    <Table.Head>Actions</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {rows.map((assignment) => {
                    const repository = currentRepositories.find((item) => item.id === assignment.repositoryId);
                    const name = repositoryName(repository, assignment.repositoryDisplayName);
                    const removed = Boolean(assignment.removedAt);
                    const canNarrow = !removed && assignment.enabled;
                    return (
                      <Table.Row key={assignment.id}>
                        <Table.Cell>
                          <strong className="text-kumo-strong">{name}</strong>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="grid gap-1">
                            <StatusBadge
                              tone={statusTone(
                                removed
                                  ? "access_removed"
                                  : assignment.enabled
                                    ? "enabled"
                                    : "disabled",
                              )}
                            >
                              {removed ? "Removed" : assignment.enabled ? "Enabled" : "Disabled"}
                            </StatusBadge>
                            <span className="text-xs text-kumo-subtle">{effectiveSummary(assignment)}</span>
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <Select
                            aria-label={`Authority ceiling for ${name}`}
                            value={assignment.authorityCeiling}
                            disabled={removed || (!owner && !canNarrow)}
                            onValueChange={(value) => {
                              const ceiling = value as PolicyMode;
                              if (ceiling === assignment.authorityCeiling) return;
                              const widening = modeRank[ceiling] > modeRank[assignment.authorityCeiling];
                              if (widening) {
                                setGuarded({ kind: "authority", assignment, repositoryName: name, ceiling });
                              } else {
                                void runOnce(() => runAuthority(assignment, ceiling));
                              }
                            }}
                          >
                            <Select.Option value="disabled">Disabled</Select.Option>
                            {(owner || modeRank[assignment.authorityCeiling] >= 1) ? (
                              <Select.Option value="approval">Approval</Select.Option>
                            ) : null}
                            {owner || assignment.authorityCeiling === "automatic" ? (
                              <Select.Option value="automatic">Automatic</Select.Option>
                            ) : null}
                          </Select>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex flex-wrap gap-2">
                            {removed && owner ? (
                              <Button
                                variant="secondary"
                                icon={PlusIcon}
                                onClick={() => setGuarded({ kind: "re-add", assignment, repositoryName: name })}
                              >
                                Re-add
                              </Button>
                            ) : null}
                            {!removed && !assignment.enabled && owner ? (
                              <Button
                                variant="secondary"
                                icon={PowerIcon}
                                onClick={() => setGuarded({ kind: "enable", assignment, repositoryName: name })}
                              >
                                Enable
                              </Button>
                            ) : null}
                            {!removed && assignment.enabled ? (
                              <Button
                                variant="secondary"
                                onClick={() =>
                                  void runOnce(() => runAssignment(assignment, "disable"))
                                }
                              >
                                Disable
                              </Button>
                            ) : null}
                            {!removed ? (
                              <Button
                                variant="destructive"
                                icon={TrashIcon}
                                onClick={() => setGuarded({ kind: "remove", assignment, repositoryName: name })}
                              >
                                Remove
                              </Button>
                            ) : null}
                          </div>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table>
            </div>
            <ul
              className="divide-y divide-kumo-hairline md:hidden"
              data-testid="deployment-mobile-list"
            >
              {rows.map((assignment) => {
                const repository = currentRepositories.find(
                  (item) => item.id === assignment.repositoryId,
                );
                const name = repositoryName(repository, assignment.repositoryDisplayName);
                const removed = Boolean(assignment.removedAt);
                const canNarrow = !removed && assignment.enabled;
                return (
                  <li key={assignment.id} className="grid gap-4 p-4">
                    <div>
                      <p className="text-xs font-semibold text-kumo-subtle">Repository</p>
                      <h3 className="mt-1 break-words text-sm font-semibold text-kumo-strong">
                        {name}
                      </h3>
                    </div>
                    <dl className="grid gap-4">
                      <div>
                        <dt className="text-xs font-semibold text-kumo-subtle">
                          Status / effective authority
                        </dt>
                        <dd className="mt-1 grid gap-1">
                          <StatusBadge
                            tone={statusTone(
                              removed
                                ? "access_removed"
                                : assignment.enabled
                                  ? "enabled"
                                  : "disabled",
                            )}
                          >
                            {removed ? "Removed" : assignment.enabled ? "Enabled" : "Disabled"}
                          </StatusBadge>
                          <span className="text-xs text-kumo-subtle">
                            {effectiveSummary(assignment)}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-semibold text-kumo-subtle">
                          Authority ceiling
                        </dt>
                        <dd className="mt-1">
                          <Select
                            className="min-h-11 min-w-11 w-full"
                            aria-label={`Authority ceiling for ${name}`}
                            value={assignment.authorityCeiling}
                            disabled={removed || (!owner && !canNarrow)}
                            onValueChange={(value) => {
                              const ceiling = value as PolicyMode;
                              if (ceiling === assignment.authorityCeiling) return;
                              const widening =
                                modeRank[ceiling] > modeRank[assignment.authorityCeiling];
                              if (widening) {
                                setGuarded({
                                  kind: "authority",
                                  assignment,
                                  repositoryName: name,
                                  ceiling,
                                });
                              } else {
                                void runOnce(() => runAuthority(assignment, ceiling));
                              }
                            }}
                          >
                            <Select.Option value="disabled">Disabled</Select.Option>
                            {owner || modeRank[assignment.authorityCeiling] >= 1 ? (
                              <Select.Option value="approval">Approval</Select.Option>
                            ) : null}
                            {owner || assignment.authorityCeiling === "automatic" ? (
                              <Select.Option value="automatic">Automatic</Select.Option>
                            ) : null}
                          </Select>
                        </dd>
                      </div>
                    </dl>
                    <div>
                      <p className="text-xs font-semibold text-kumo-subtle">Actions</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {removed && owner ? (
                          <Button
                            className="min-h-11 min-w-11"
                            variant="secondary"
                            icon={PlusIcon}
                            onClick={() =>
                              setGuarded({
                                kind: "re-add",
                                assignment,
                                repositoryName: name,
                              })
                            }
                          >
                            Re-add
                          </Button>
                        ) : null}
                        {!removed && !assignment.enabled && owner ? (
                          <Button
                            className="min-h-11 min-w-11"
                            variant="secondary"
                            icon={PowerIcon}
                            onClick={() =>
                              setGuarded({
                                kind: "enable",
                                assignment,
                                repositoryName: name,
                              })
                            }
                          >
                            Enable
                          </Button>
                        ) : null}
                        {!removed && assignment.enabled ? (
                          <Button
                            className="min-h-11 min-w-11"
                            variant="secondary"
                            onClick={() =>
                              void runOnce(() => runAssignment(assignment, "disable"))
                            }
                          >
                            Disable
                          </Button>
                        ) : null}
                        {!removed ? (
                          <Button
                            className="min-h-11 min-w-11"
                            variant="destructive"
                            icon={TrashIcon}
                            onClick={() =>
                              setGuarded({
                                kind: "remove",
                                assignment,
                                repositoryName: name,
                              })
                            }
                          >
                            Remove
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            </>
          ) : (
            <EmptyState
              compact
              title="No repository deployments"
              description={
                "This Agent has no repository authority. Add a current repository to create " +
                "a disabled deployment."
              }
            />
          )}
        </>
      )}
      <ConfirmDialog
        open={Boolean(guarded)}
        onOpenChange={(open) => {
          if (!open) {
            guardedRef.current = null;
            setGuarded(null);
          }
        }}
        title={guardedTitle}
        description={
          renderedGuarded?.kind === "all"
            ? `This adds only ${available.length} missing ${
                available.length === 1 ? "deployment" : "deployments"
              } for ${agent.name}. The request materializes exactly ${
                renderedGuarded.repositories.length
              } current repositories: ${
                renderedGuarded.repositories.map((item) => repositoryName(item)).join(", ")
              }. Future repositories are not included.`
            : `${agent.name} and ${guardedRepository ?? "the named repository"} are the exact scope of this change.`
        }
        confirmLabel={guardedTitle.replace(/\?$/, "")}
        confirmTone={renderedGuarded?.kind === "remove" ? "destructive" : "primary"}
        loading={mutationPending}
        onConfirm={confirmGuarded}
      />
      <ConfirmDialog
        open={Boolean(overlap)}
        onOpenChange={(open) => {
          if (!open) {
            overlapRef.current = null;
            setOverlap(null);
          }
        }}
        title={`Confirm overlapping deployment for ${agent.name}?`}
        description="Multiple Agents may run independently for the same event and may each produce effects."
        detail={renderedOverlap ? (
          <div className="grid gap-3 text-sm">
            {warningRepositories(renderedOverlap.warning).map((item) => (
              <div key={item.repositoryId}>
                <strong className="text-kumo-strong">
                  {item.repositoryDisplayName ??
                    repositoryName(
                      currentRepositories.find((repo) => repo.id === item.repositoryId),
                    )}
                </strong>
                {item.conflicts.map((conflict) => (
                  <p key={conflict.assignmentId} className="mt-1 text-kumo-subtle">
                    {agent.name} overlaps {conflict.agentDisplayName ?? "another Agent"}.
                    {` Shared triggers: ${
                      conflict.sharedTriggers.join(", ") || "none"
                    }.`}
                    {` Shared effects: ${conflict.sharedEffects.join(", ") || "none"}.`}
                  </p>
                ))}
              </div>
            ))}
          </div>
        ) : null}
        confirmLabel={`Allow ${agent.name} overlap on named repositories`}
        loading={mutationPending}
        onConfirm={() => {
          const current = overlapRef.current;
          if (!current || current.warning.fingerprint !== renderedOverlap?.warning.fingerprint) {
            return;
          }
          return current.retry();
        }}
      />
      {overlap ? (
        <div className="p-4 pt-0">
          <Banner
            variant="secondary"
            title="Independent Agent overlap requires confirmation"
            description={
              "Review the named repositories, Agents, shared triggers, and shared effects before " +
              "continuing."
            }
          />
        </div>
      ) : null}
    </Panel>
  );
}
