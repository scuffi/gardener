import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
import { formatDuration } from "./format-run";

export function RunsPage() {
  const [status, setStatus] = useState("all");
  const query = useQuery({
    queryKey: queryKeys.runs,
    queryFn: () => gardenerApi.runs(),
  });

  if (query.isLoading) {
    return (
      <>
        <PageHeaderSkeleton />
        <Panel padded={false}>
          <TableSkeleton rows={7} columns={6} />
        </Panel>
      </>
    );
  }

  if (query.error || !query.data) {
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

  const runs = query.data.runs;
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
                  "border-b border-kumo-hairline bg-kumo-elevated px-4 py-2.5 " +
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
                          "grid! min-h-12 grid-cols-[130px_minmax(160px,1.2fr)_minmax(120px,1fr)_100px_110px_130px] " +
                          "items-center px-4 py-2.5 !text-kumo-default no-underline " +
                          "transition-[box-shadow,transform] duration-300 " +
                          "ease-[cubic-bezier(0.22,1,0.36,1)] hover:translate-x-px " +
                          "hover:shadow-[inset_3px_0_0_var(--color-kumo-brand)] " +
                          "focus-visible:shadow-[inset_3px_0_0_var(--color-kumo-brand)]"
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
