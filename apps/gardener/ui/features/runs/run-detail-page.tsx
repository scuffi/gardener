import { ArrowLeftIcon, ArrowsClockwiseIcon, ListChecksIcon, ReceiptIcon, StackIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { gardenerApi } from "../../lib/api";
import { formatDate, sentenceCase } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import {
  ClipboardText,
  ErrorState,
  Link,
  Mono,
  PageHeader,
  PageHeaderSkeleton,
  Panel,
  RunStatus,
  shortHash,
  Stat,
  TableSkeleton,
} from "../../primitives";
import { EffectsTable } from "./components/effects-table";
import { StepTimeline } from "./components/step-timeline";
import { TaskGraph } from "./components/task-graph";
import { formatDuration } from "./format-run";

const EXECUTED = new Set(["executed", "completed"]);

function BackToRuns() {
  return (
    <Link href="/runs" variant="plain" className="inline-flex items-center gap-1.5 text-sm">
      <ArrowLeftIcon size={15} aria-hidden="true" />
      All runs
    </Link>
  );
}

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const query = useQuery({
    queryKey: queryKeys.run(id),
    queryFn: () => gardenerApi.run(id!),
    enabled: Boolean(id),
  });

  if (query.isLoading) {
    return (
      <>
        <PageHeaderSkeleton />
        <Panel padded={false}>
          <TableSkeleton rows={6} columns={4} />
        </Panel>
      </>
    );
  }

  if (query.error || !query.data) {
    const message = (query.error as Error)?.message ?? "This run could not be loaded.";
    return (
      <>
        <div className="mb-4">
          <BackToRuns />
        </div>
        <ErrorState
          title="Run unavailable"
          message={message}
          onRetry={() => void query.refetch()}
        />
      </>
    );
  }

  const { run, tasks, steps, effects } = query.data;
  const retries = steps.reduce((total, step) => total + Math.max(0, step.attempt_count - 1), 0);
  const executed = effects.filter((effect) => EXECUTED.has(effect.status)).length;

  return (
    <>
      <div className="mb-4">
        <BackToRuns />
      </div>

      <PageHeader
        title={sentenceCase(run.kind)}
        description={`Started ${formatDate(run.started_at ?? run.created_at)}`}
        actions={<RunStatus status={run.status} />}
      />

      <Panel className="mb-5">
        <dl className="grid grid-cols-4 gap-x-6 gap-y-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
          <div className="min-w-0">
            <dt className="text-xs font-medium text-kumo-subtle">Run</dt>
            <dd className="mt-1">
              <ClipboardText
                size="sm"
                text={shortHash(run.id)}
                textToCopy={run.id}
                tooltip={{ text: "Copy run ID", copiedText: "Run ID copied", side: "top" }}
              />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-medium text-kumo-subtle">Agent</dt>
            <dd className="mt-1">
              <Mono truncate tone="default" title={run.agent_id ?? undefined}>
                {run.agent_id ?? "unassigned"}
              </Mono>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-medium text-kumo-subtle">Duration</dt>
            <dd className="mt-1 text-sm text-kumo-default">
              {formatDuration(run.started_at, run.completed_at)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-medium text-kumo-subtle">Harness</dt>
            <dd className="mt-1">
              <Mono truncate tone="default" title={run.harness_id ?? undefined}>
                {run.harness_id ?? "—"}
              </Mono>
            </dd>
          </div>
        </dl>
      </Panel>

      <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
        <Stat icon={StackIcon} label="Tasks" value={tasks.length} />
        <Stat icon={ListChecksIcon} label="Steps" value={steps.length} />
        <Stat
          icon={ArrowsClockwiseIcon}
          label="Retries"
          value={retries}
          tone={retries > 0 ? "warning" : "default"}
          detail={retries === 0 ? "No step was retried" : "Steps that needed another attempt"}
        />
        <Stat
          icon={ReceiptIcon}
          label="Effects executed"
          value={executed}
          tone={executed > 0 ? "success" : "default"}
          detail={`of ${effects.length} proposed`}
        />
      </div>

      <div className="mt-5 grid gap-4">
        <TaskGraph tasks={tasks} />
        <StepTimeline tasks={tasks} steps={steps} />
        <EffectsTable effects={effects} />
      </div>
    </>
  );
}
