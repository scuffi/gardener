import { ArrowRightIcon, PulseIcon } from "@phosphor-icons/react";
import { formatRelativeTime, sentenceCase } from "../../../lib/format";
import type { RunSummary } from "../../../lib/types";
import {
  EmptyState,
  Link,
  Mono,
  Panel,
  PanelHeader,
  StatusBadge,
  statusTone,
  shortHash,
} from "../../../primitives";

export function RecentRunsPanel({ runs }: { runs: RunSummary[] }) {
  return (
    <Panel padded={false} className="h-full">
      <PanelHeader
        title="Recent runs"
        description="The latest work across every active repository."
        actions={
          <Link href="/runs" variant="plain" className="inline-flex items-center gap-1 text-sm text-kumo-link">
            View all runs
            <ArrowRightIcon size={15} aria-hidden="true" />
          </Link>
        }
      />
      {runs.length ? (
        <div className="divide-y divide-kumo-hairline">
          {runs.slice(0, 8).map((run) => (
            <Link
              key={run.id}
              href={`/runs/${run.id}`}
              variant="plain"
              className={
                "grid min-h-[66px] min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 " +
                "gap-y-1 px-4 py-3 text-kumo-default hover:bg-kumo-tint max-[520px]:items-start"
              }
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-baseline gap-2.5">
                  <Mono tone="strong" title={run.id}>
                    {shortHash(run.id)}
                  </Mono>
                  <Mono truncate title={run.kind}>
                    {run.kind}
                  </Mono>
                </div>
                <p className="mt-1 truncate text-xs text-kumo-subtle">
                  Agent {run.agent_id ?? "unassigned"} · {formatRelativeTime(run.created_at)}
                </p>
              </div>
              <StatusBadge tone={statusTone(run.status)}>{sentenceCase(run.status)}</StatusBadge>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          compact
          icon={PulseIcon}
          title="No runs yet"
          description="Agent activity will appear here after Gardener starts its first run."
        />
      )}
    </Panel>
  );
}
