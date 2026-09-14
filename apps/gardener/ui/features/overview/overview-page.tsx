import { GitBranchIcon, PulseIcon, SpinnerGapIcon, TrayIcon } from "@phosphor-icons/react";
import { useGardener } from "../../app-context";
import { isEnabled } from "../../lib/format";
import type { RunSummary } from "../../lib/types";
import { ErrorState, PageHeader, Stat, type StatTone } from "../../primitives";
import { NeedsAttentionPanel } from "./components/needs-attention-panel";
import { OverviewPageSkeleton } from "./components/overview-page-skeleton";
import { RecentRunsPanel } from "./components/recent-runs-panel";

const DAY_MS = 24 * 60 * 60 * 1000;

/** D1 timestamps have no zone suffix; treat them as UTC rather than local. */
function timestamp(value?: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(`${value}Z`.replace("ZZ", "Z")).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function isRecent(run: RunSummary): boolean {
  const created = timestamp(run.created_at);
  return created !== null && Date.now() - created < DAY_MS;
}

const SETTLED = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);
const FAILED = new Set(["failed", "completed_with_errors"]);

export function OverviewPage() {
  const { state, health, error, refresh } = useGardener();

  if (error && !state) {
    return (
      <>
        <PageHeader
          title="Overview"
          description="Fleet health, work in flight, and anything waiting on a decision."
        />
        <ErrorState
          message={error.message || "Gardener could not load this deployment."}
          onRetry={() => void refresh()}
        />
      </>
    );
  }

  if (!state || !health) return <OverviewPageSkeleton />;

  const runs = state.runs ?? [];
  const recent = runs.filter(isRecent);
  const settled = recent.filter((run) => SETTLED.has(run.status));
  const failed = recent.filter((run) => FAILED.has(run.status));
  const running = runs.filter((run) => run.status === "running" || run.status === "queued");
  const awaiting = state.inboxCount ?? 0;
  const activeRepositories = state.repositories.filter((repository) =>
    isEnabled(repository.active),
  );

  // Only claim a success rate once something has actually finished.
  const successRate =
    settled.length > 0
      ? `${Math.round(((settled.length - failed.length) / settled.length) * 100)}% succeeded`
      : "No runs have finished yet";

  const runsTone: StatTone = failed.length > 0 ? "danger" : "default";
  const runningTone: StatTone = running.length > 0 ? "info" : "default";
  const inboxTone: StatTone = awaiting > 0 ? "warning" : "success";
  const repositoriesTone: StatTone = activeRepositories.length > 0 ? "success" : "warning";

  return (
    <>
      <PageHeader
        title="Overview"
        description="Fleet health, work in flight, and anything waiting on a decision."
      />

      <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
        <Stat
          href="/runs"
          icon={PulseIcon}
          tone={runsTone}
          label="Runs, last 24 hours"
          value={recent.length}
          detail={successRate}
        />
        <Stat
          href="/runs"
          icon={SpinnerGapIcon}
          tone={runningTone}
          label="In flight"
          value={running.length}
          detail={running.length === 1 ? "1 run active now" : `${running.length} runs active now`}
        />
        <Stat
          href="/inbox"
          icon={TrayIcon}
          tone={inboxTone}
          label="Awaiting a decision"
          value={awaiting}
          detail={awaiting === 0 ? "Inbox is clear" : "Waiting on an operator"}
        />
        <Stat
          href="/repositories"
          icon={GitBranchIcon}
          tone={repositoriesTone}
          label="Active repositories"
          value={activeRepositories.length}
          detail={
            activeRepositories.length === 0
              ? "Connect one to start"
              : `of ${state.repositories.length} connected`
          }
        />
      </div>

      <div className="mt-5 grid grid-cols-2 items-start gap-4 max-lg:grid-cols-1">
        <RecentRunsPanel runs={runs} />
        <NeedsAttentionPanel state={state} health={health} runs={recent} />
      </div>
    </>
  );
}
