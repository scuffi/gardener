import { RobotIcon } from "@phosphor-icons/react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { AssignmentListResponse } from "../../../lib/types";
import {
  EmptyState,
  ErrorState,
  Link,
  LoadingState,
  StatusBadge,
  statusTone,
} from "../../../primitives";
import { modeLabels } from "../constants";

export function RepositoryAssignmentList({
  query,
}: {
  query: UseQueryResult<AssignmentListResponse, Error>;
}) {
  if (query.isLoading) {
    return <LoadingState label="Loading assigned Agents" />;
  }
  if (query.error) {
    return (
      <ErrorState
        message={query.error.message}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const assignments = query.data?.assignments ?? [];
  if (!assignments.length) {
    return (
      <EmptyState
        compact
        icon={RobotIcon}
        title="No Agents assigned"
        description="Assigned Agents will appear here with their runtime state and authority ceiling."
      />
    );
  }
  return (
    <ul className="grid min-w-0 list-none gap-2 p-0" aria-label="Assigned Agents">
      {assignments.map((assignment) => {
        const status = assignment.removedAt
          ? "access_removed"
          : assignment.enabled
            ? "enabled"
            : "disabled";
        const name = assignment.agentDisplayName ?? "Unnamed Agent";
        return (
          <li key={assignment.id} className="min-w-0">
            <Link
              href={`/agents/${encodeURIComponent(assignment.agentId)}`}
              variant="plain"
              className={
                "flex min-h-11 min-w-0 w-full items-center justify-between gap-3 rounded-md border " +
                "border-kumo-hairline bg-kumo-base px-3 py-2 hover:bg-kumo-tint " +
                "max-sm:flex-col max-sm:items-start"
              }
              aria-label={`${name}, ${status.replace("_", " ")}, view Agent`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <RobotIcon size={18} className="flex-none text-kumo-subtle" aria-hidden="true" />
                <span className="min-w-0 break-words">
                  <strong className="block text-sm font-semibold text-kumo-strong">
                    {name}
                  </strong>
                  <span className="block break-words text-xs text-kumo-subtle">
                    Ceiling {modeLabels[assignment.authorityCeiling]} · effective authority is also
                    bounded by repository policy
                  </span>
                </span>
              </span>
              <StatusBadge tone={statusTone(status)}>
                {assignment.removedAt ? "Removed" : assignment.enabled ? "Enabled" : "Disabled"}
              </StatusBadge>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
