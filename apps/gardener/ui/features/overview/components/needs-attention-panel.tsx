import {
  CheckCircleIcon,
  DatabaseIcon,
  GitBranchIcon,
  PauseCircleIcon,
  PulseIcon,
  ShieldSlashIcon,
} from "@phosphor-icons/react";
import { isEnabled } from "../../../lib/format";
import type { AppState, HealthState, RunSummary } from "../../../lib/types";
import { Link, Panel, PanelHeader, StatusBadge } from "../../../primitives";

export function NeedsAttentionPanel({
  state,
  health,
  runs,
}: {
  state: AppState;
  health: HealthState;
  runs: RunSummary[];
}) {
  const pausedRepositories = state.repositories.filter((repository) => repository.paused);
  const disabledPolicies = state.policies.filter(
    (policy) => policy.mode === "disabled" || String(policy.mode) === "off",
  );
  const failedRuns = runs.filter(
    (run) => run.status === "failed" || run.status === "completed_with_errors",
  );
  const unhealthyServices = [
    !health.database && "database",
    !health.workersAi && "Workers AI",
    !health.connectConfigured && "Gardener Connect",
    !health.agentRuntime.enabled && "agent runtime",
  ].filter((service): service is string => Boolean(service));
  const alerts = [
    ...(state.globalPaused
      ? [
          {
            title: "Fleet is globally paused",
            description: "New agent work is held until the global pause is lifted.",
            href: "/settings",
            icon: PauseCircleIcon,
            tone: "warning" as const,
            status: "Paused",
          },
        ]
      : []),
    ...(unhealthyServices.length
      ? [
          {
            title: `${unhealthyServices.length} ${
              unhealthyServices.length === 1 ? "service is" : "services are"
            } unavailable`,
            description: `Check ${unhealthyServices.join(", ")} before starting new work.`,
            href: "/settings",
            icon: DatabaseIcon,
            tone: "danger" as const,
            status: "Review",
          },
        ]
      : []),
    ...(pausedRepositories.length
      ? [
          {
            title: `${pausedRepositories.length} paused ${
              pausedRepositories.length === 1 ? "repository" : "repositories"
            }`,
            description: "Paused repositories can receive access but will not start new agent work.",
            href: "/repositories",
            icon: GitBranchIcon,
            tone: "warning" as const,
            status: "Paused",
          },
        ]
      : []),
    ...(disabledPolicies.length
      ? [
          {
            title: `${disabledPolicies.length} ${
              disabledPolicies.length === 1 ? "policy is" : "policies are"
            } off`,
            description: "Operations covered by these policies cannot be proposed or executed.",
            href: "/policies",
            icon: ShieldSlashIcon,
            tone: "warning" as const,
            status: "Off",
          },
        ]
      : []),
    ...(failedRuns.length
      ? [
          {
            title:
              `${failedRuns.length} recent `
              + `${failedRuns.length === 1 ? "run needs" : "runs need"} review`,
            description: "Failed runs and runs completed with errors are included.",
            href: "/runs",
            icon: PulseIcon,
            tone: "danger" as const,
            status: "Review",
          },
        ]
      : []),
  ];
  const activeRepositories = state.repositories.filter((repository) => isEnabled(repository.active));

  return (
    <Panel padded={false} className="h-full">
      <PanelHeader
        title="Needs attention"
        description="Conditions that may block work or require an operator."
      />
      {alerts.length ? (
        <div className="divide-y divide-kumo-hairline">
          {alerts.map((alert) => (
            <Link
              key={alert.title}
              href={alert.href}
              variant="plain"
              className={
                "grid min-h-[66px] grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 "
                + "px-4 py-3 hover:bg-kumo-tint"
              }
            >
              <span
                className={
                  alert.tone === "danger"
                    ? "grid size-9 place-items-center rounded-md bg-kumo-danger/10 text-kumo-danger"
                    : "grid size-9 place-items-center rounded-md bg-kumo-warning/10 text-kumo-warning"
                }
              >
                <alert.icon size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-kumo-strong">{alert.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-kumo-subtle">{alert.description}</p>
              </div>
              <StatusBadge tone={alert.tone}>{alert.status}</StatusBadge>
            </Link>
          ))}
        </div>
      ) : (
        <div className="flex min-h-40 items-center gap-4 px-5 py-6">
          <span className="grid size-11 flex-none place-items-center rounded-full bg-kumo-success/10 text-kumo-success">
            <CheckCircleIcon size={24} weight="fill" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="font-medium text-kumo-strong">Fleet is ready</p>
            <p className="mt-1 text-sm leading-relaxed text-kumo-subtle">
              Services are healthy, policies are available, and {activeRepositories.length} active
              {activeRepositories.length === 1 ? " repository is" : " repositories are"} ready for work.
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}
