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
  Table,
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
            <Table className="min-w-[760px] text-sm">
              <Table.Header variant="compact">
                <Table.Row>
                  <Table.Head sticky="left">Status</Table.Head>
                  <Table.Head>Kind</Table.Head>
                  <Table.Head>Agent</Table.Head>
                  <Table.Head>Duration</Table.Head>
                  <Table.Head>Created</Table.Head>
                  <Table.Head>Run ID</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {visibleRuns.map((run) => {
                  const href = `/runs/${encodeURIComponent(run.id)}`;
                  return (
                    <Table.Row key={run.id}>
                      <Table.Cell sticky="left" className="whitespace-nowrap">
                        <Link href={href} variant="plain" aria-label={`Open run ${run.id}`}>
                          <StatusBadge tone={statusTone(run.status)}>
                            {sentenceCase(run.status)}
                          </StatusBadge>
                        </Link>
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap">
                        <Mono tone="default">{run.kind}</Mono>
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap">
                        {run.agent_id ? <Mono title={run.agent_id}>{shortHash(run.agent_id)}</Mono> : "—"}
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap">
                        {formatDuration(run.started_at, run.completed_at)}
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap">
                        {formatRelativeTime(run.created_at)}
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap">
                        <Link href={href} variant="plain">
                          <Mono title={run.id} tone="default">{shortHash(run.id)}</Mono>
                        </Link>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        )}
      </Panel>
    </>
  );
}
