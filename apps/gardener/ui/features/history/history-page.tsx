import { ClockCounterClockwiseIcon, RobotIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { gardenerApi } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import {
  EmptyState,
  ErrorState,
  LinkButton,
  Mono,
  PageHeader,
  Panel,
  RunStatus,
  TableSkeleton,
} from "../../primitives";

export function HistoryPage() {
  const query = useQuery({ queryKey: queryKeys.history, queryFn: gardenerApi.history });
  const items = query.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="History"
        description={
          "Inspect Agent runs, decisions, revision changes, and administrative actions. Receipts " +
          "and security audit records remain the authoritative proof."
        }
      />
      {query.isLoading ? (
        <Panel padded={false}>
          <TableSkeleton rows={5} columns={2} />
        </Panel>
      ) : query.error ? (
        <ErrorState
          message={(query.error as Error).message}
          onRetry={() => void query.refetch()}
        />
      ) : items.length ? (
        <Panel>
          <ol className="m-0 list-none p-0">
            {items.map((item) => (
              <li
                key={item.id}
                className={
                  "relative grid grid-cols-[20px_minmax(0,1fr)] gap-3 pb-[18px] " +
                  "before:absolute before:top-4 before:bottom-0 before:left-[9px] before:w-px " +
                  "before:bg-kumo-recessed before:content-[''] last:pb-0 last:before:hidden"
                }
              >
                <span
                  aria-hidden="true"
                  className={
                    "z-10 m-[5px] size-[9px] rounded-full border-2 border-kumo-base " +
                    "bg-kumo-brand ring-1 ring-kumo-brand"
                  }
                />
                <article className="min-w-0 rounded-md border border-kumo-hairline bg-kumo-elevated p-3.5">
                  <header className="flex items-start justify-between gap-3">
                    <div className="grid min-w-0">
                      <strong className="text-sm text-kumo-strong">{item.title}</strong>
                      <span className="flex flex-wrap items-center gap-1 text-xs text-kumo-default">
                        <Mono>{item.kind}</Mono>
                        <span aria-hidden="true">·</span>
                        <span>{formatRelativeTime(item.createdAt)}</span>
                      </span>
                    </div>
                    {item.status ? <RunStatus status={item.status} /> : null}
                  </header>
                  {item.summary ? (
                    <p className="mt-2 text-sm text-kumo-default">{item.summary}</p>
                  ) : null}
                  {item.actor ? (
                    <small className="mt-2 flex items-center gap-1 text-xs text-kumo-default">
                      Actor: <Mono>{item.actor}</Mono>
                    </small>
                  ) : null}
                </article>
              </li>
            ))}
          </ol>
        </Panel>
      ) : (
        <EmptyState
          icon={ClockCounterClockwiseIcon}
          title="No history yet"
          description="Agent revisions, runs, durable decisions, and policy changes will appear here."
          action={
            <LinkButton href="/agents" variant="secondary" icon={RobotIcon}>
              View Agents
            </LinkButton>
          }
        />
      )}
    </>
  );
}
