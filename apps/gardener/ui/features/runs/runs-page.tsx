import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useGardener } from "../../app-context";
import { gardenerApi } from "../../lib/api";
import { formatRelativeTime, sentenceCase } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import {
  EmptyState,
  ErrorState,
  Link,
  Mono,
  PageHeader,
  PageHeaderSkeleton,
  Panel,
  Select,
  shortHash,
  StatusBadge,
  statusTone,
  TableSkeleton,
} from "../../primitives";
import type { ActionsTaskRunSummary } from "../../lib/types";
import { formatDuration } from "./format-run";

export function RunsPage() {
  const { health } = useGardener();
  const actionsOnly = health?.deploymentMode === "actions-v1";
  const [status, setStatus] = useState("all");
  const query = useQuery({
    queryKey: queryKeys.runs,
    queryFn: () => gardenerApi.runs(),
    enabled: !actionsOnly,
  });
  const actionsRunsQuery = useQuery({
    queryKey: queryKeys.actionsTaskRuns,
    queryFn: () => gardenerApi.actionsRuns(),
  });

  if (!actionsOnly && query.isLoading) {
    return (
      <>
        <PageHeaderSkeleton />
        <Panel padded={false}>
          <TableSkeleton rows={7} columns={6} />
        </Panel>
      </>
    );
  }

  if (!actionsOnly && (query.error || !query.data)) {
    return (
      <>
        <PageHeader
          title="Runs"
          description="Inspect the exact work Gardener attempted, including timing and outcomes."
        />
        <ErrorState
          message={(query.error as Error)?.message ?? "Run history is unavailable."}
          onRetry={() => void query.refetch()}
        />
      </>
    );
  }

  if (actionsOnly) {
    return (
      <>
        <PageHeader
          title="Runs"
          description="Issue triage plans and the exact GitHub effects executed from Actions."
        />
        {actionsRunsQuery.error ? (
          <ErrorState
            message={(actionsRunsQuery.error as Error).message}
            onRetry={() => void actionsRunsQuery.refetch()}
          />
        ) : (
          <ActionsRunsPanel
            runs={actionsRunsQuery.data?.runs ?? []}
            loading={actionsRunsQuery.isLoading}
          />
        )}
      </>
    );
  }

  const runs = query.data!.runs;
  const statuses = [...new Set(runs.map((run) => run.status))].sort();
  const visibleRuns = status === "all" ? runs : runs.filter((run) => run.status === status);

  return (
    <>
      <PageHeader
        title="Runs"
        description="Inspect the exact work Gardener attempted, including timing, outcomes, and authority effects."
        actions={
          <Select
            aria-label="Filter runs by status"
            size="sm"
            className="w-44"
            value={status}
            onValueChange={(value) => setStatus(value ?? "all")}
            items={Object.fromEntries([
              ["all", "All statuses"],
              ...statuses.map((item) => [item, sentenceCase(item)]),
            ])}
          />
        }
      />
      <ActionsRunsPanel runs={actionsRunsQuery.data?.runs ?? []} loading={actionsRunsQuery.isLoading} />
      <Panel padded={false}>
        {!runs.length ? (
          <EmptyState
            title="No runs have started"
            description="Runs will appear here when an enabled Agent responds to an armed trigger."
          />
        ) : !visibleRuns.length ? (
          <EmptyState
            compact
            title="No runs match this status"
            description="Choose another status to inspect the available run history."
          />
        ) : (
          <div className="min-w-0 overflow-x-auto">
            <div className="min-w-[760px] text-sm">
              <div
                aria-hidden="true"
                className={
                  "grid grid-cols-[130px_minmax(160px,1.2fr)_minmax(120px,1fr)_100px_110px_130px] " +
                  "border-b border-kumo-hairline bg-(--color-gardener-surface-strong) px-4 py-2.5 " +
                  "text-xs font-semibold text-kumo-strong"
                }
              >
                <span>Status</span>
                <span>Kind</span>
                <span>Agent</span>
                <span>Duration</span>
                <span>Created</span>
                <span>Run ID</span>
              </div>
              <ul className="m-0 list-none divide-y divide-kumo-hairline p-0">
                {visibleRuns.map((run) => {
                  const href = `/runs/${encodeURIComponent(run.id)}`;
                  const duration = formatDuration(run.started_at, run.completed_at);
                  const created = formatRelativeTime(run.created_at);
                  const agent = run.agent_id ?? "unassigned";
                  const summary =
                    `Open run ${run.id}. Status: ${sentenceCase(run.status)}. ` +
                    `Kind: ${run.kind}. Agent: ${agent}. Duration: ${duration}. Created: ${created}.`;
                  return (
                    <li key={run.id}>
                      <Link
                        href={href}
                        variant="plain"
                        aria-label={summary}
                        className={
                          "relative isolate grid! min-h-12 overflow-hidden " +
                          "grid-cols-[130px_minmax(160px,1.2fr)_minmax(120px,1fr)_100px_110px_130px] " +
                          "items-center px-4 py-2.5 !text-kumo-default no-underline transition-none " +
                          "before:pointer-events-none before:absolute before:inset-0 " +
                          "before:bg-(--color-gardener-accent-wash) " +
                          "before:opacity-0 before:transition-opacity before:duration-300 " +
                          "before:ease-[cubic-bezier(0.22,1,0.36,1)] hover:before:opacity-100 " +
                          "focus-visible:before:opacity-100 motion-reduce:before:transition-none " +
                          "hover:!text-kumo-default"
                        }
                      >
                        <span className="whitespace-nowrap">
                          <StatusBadge tone={statusTone(run.status)}>
                            {sentenceCase(run.status)}
                          </StatusBadge>
                        </span>
                        <Mono tone="default">{run.kind}</Mono>
                        <span className="whitespace-nowrap">
                          {run.agent_id ? (
                            <Mono title={run.agent_id}>{shortHash(run.agent_id)}</Mono>
                          ) : (
                            "—"
                          )}
                        </span>
                        <span className="whitespace-nowrap">
                          {duration}
                        </span>
                        <span className="whitespace-nowrap">
                          {created}
                        </span>
                        <Mono title={run.id} tone="default">{shortHash(run.id)}</Mono>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}

function ActionsRunsPanel({ runs, loading }: { runs: ActionsTaskRunSummary[]; loading: boolean }) {
  return (
    <Panel padded={false}>
      <div className="border-b border-kumo-hairline px-4 py-3">
        <h2 className="m-0 text-sm font-semibold text-kumo-strong">Actions-native issue triage</h2>
        <p className="mb-0 mt-1 text-xs text-kumo-subtle">
          Planning outcomes and exact GitHub comment receipts.
        </p>
      </div>
      {loading ? (
        <div className="px-4 py-4 text-sm text-kumo-subtle">Loading Actions runs…</div>
      ) : runs.length === 0 ? (
        <div className="px-4 py-4 text-sm text-kumo-subtle">No Actions-native triage run has started.</div>
      ) : (
        <ul className="m-0 list-none divide-y divide-kumo-hairline p-0">
          {runs.map((run) => {
            const comment = run.outcome?.proposedEffects
              ?.find((effect) => effect.kind === "issue.comment.create")?.body;
            const displayStatus = run.effectReceipt ? "completed" : run.status;
            return (
              <li
                key={run.id}
                className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[150px_minmax(0,1fr)_minmax(280px,0.8fr)]"
              >
                <span>
                  <StatusBadge tone={statusTone(displayStatus)}>
                    {run.effectReceipt ? "Comment posted" : sentenceCase(run.status)}
                  </StatusBadge>
                </span>
                <div className="min-w-0">
                  <div className="font-medium text-kumo-strong">{run.outcome?.summary ?? "Planning in progress"}</div>
                  {comment ? <div className="mt-1 line-clamp-2 text-xs text-kumo-subtle">{comment}</div> : null}
                </div>
                <div className="grid min-w-0 gap-1 text-xs text-kumo-subtle">
                  <div>GitHub run {run.githubRunId} · attempt {run.githubRunAttempt}</div>
                  {run.effectReceipt ? (
                    <>
                      <div className="break-all">
                        Operation <Mono tone="default">{run.effectReceipt.operationId}</Mono>
                      </div>
                      <div className="break-all">
                        Artifact <Mono tone="default">{run.effectReceipt.artifactSha256}</Mono>
                      </div>
                      <Link href={run.effectReceipt.commentUrl}>
                        GitHub comment {run.effectReceipt.commentId}
                      </Link>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
