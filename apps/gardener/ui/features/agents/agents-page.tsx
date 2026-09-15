import { PlusIcon, RobotIcon } from "@phosphor-icons/react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { gardenerApi } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import {
  CardLink,
  CardSkeleton,
  EmptyState,
  ErrorState,
  LinkButton,
  Mono,
  PageHeader,
  Panel,
  Select,
  StatusBadge,
  statusTone,
} from "../../primitives";

export function AgentsPage() {
  const [repositoryId, setRepositoryId] = useState("all");
  const query = useQuery({ queryKey: queryKeys.agents, queryFn: gardenerApi.agents });
  const agents = query.data?.agents ?? [];
  const assignmentQueries = useQueries({
    queries: agents.map((agent) => ({
      queryKey: queryKeys.agentAssignments(agent.id),
      queryFn: () => gardenerApi.agentAssignments(agent.id),
    })),
  });
  const assignmentsLoading = assignmentQueries.some((item) => item.isLoading);
  const assignmentsError = assignmentQueries.find((item) => item.error)?.error as Error | undefined;
  const repositories = Array.from(
    new Map(
      assignmentQueries.flatMap((item) =>
        (item.data?.assignments ?? [])
          .filter((assignment) => !assignment.removedAt)
          .map((assignment) => [
            assignment.repositoryId,
            assignment.repositoryDisplayName ?? "Unknown repository",
          ] as const),
      ),
    ),
  );
  const visibleAgents = agents.filter((_, index) =>
    repositoryId === "all"
      ? true
      : assignmentQueries[index]?.data?.assignments.some(
          (assignment) => assignment.repositoryId === repositoryId && !assignment.removedAt,
        ),
  );
  const create = (
    <LinkButton
      className="max-md:min-h-11 max-md:min-w-11"
      href="/agents/new"
      icon={PlusIcon}
    >
      New Agent
    </LinkButton>
  );

  return (
    <>
      <PageHeader
        title="Agents"
        description={
          "Portable AGENT.md packages define behavior. Capabilities, repository scope, policies, " +
          "and activation remain separate authority layers."
        }
        actions={create}
      />
      {repositories.length ? (
        <Panel className="mb-4">
          <Select
            className="max-md:min-h-11 max-md:min-w-11"
            label="Filter Agents by repository"
            hideLabel={false}
            value={repositoryId}
            onValueChange={(value) => setRepositoryId(value ?? "all")}
          >
            <Select.Option value="all">All repositories</Select.Option>
            {repositories.map(([id, name]) => (
              <Select.Option key={id} value={id}>{name}</Select.Option>
            ))}
          </Select>
        </Panel>
      ) : null}
      {query.isLoading || assignmentsLoading ? (
        <CardSkeleton />
      ) : query.error || assignmentsError ? (
        <ErrorState
          message={(query.error as Error)?.message ?? assignmentsError?.message ?? "Agents unavailable"}
          onRetry={() => {
            void query.refetch();
            assignmentQueries.forEach((item) => void item.refetch());
          }}
        />
      ) : visibleAgents.length ? (
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          {visibleAgents.map((agent) => {
            const index = agents.findIndex((item) => item.id === agent.id);
            const assigned = assignmentQueries[index]?.data?.assignments.filter(
              (assignment) => !assignment.removedAt,
            ) ?? [];
            const enabled = assigned.filter((assignment) => assignment.enabled).length;
            return (
            <CardLink
              key={agent.id}
              href={`/agents/${encodeURIComponent(agent.id)}`}
              label={`Open Agent ${agent.name}`}
            >
              <div className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)] gap-3">
                <span
                  className={
                    "grid size-10 place-items-center rounded-md " +
                    "bg-(--color-gardener-accent-wash) text-(--color-gardener-accent-display)"
                  }
                >
                  <RobotIcon size={20} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-3 max-sm:flex-col">
                    <h2 className="text-base font-semibold text-kumo-strong">{agent.name}</h2>
                    <span className="flex flex-wrap justify-end gap-1 max-sm:justify-start">
                      <StatusBadge tone={statusTone(agent.lifecycle)}>
                        {agent.lifecycle === "active" ? "Active revision" : agent.lifecycle}
                      </StatusBadge>
                      <StatusBadge tone={statusTone(enabled ? "enabled" : "disabled")}>
                        {assigned.length
                          ? `${enabled} of ${assigned.length} deployments enabled`
                          : "No repository deployments"}
                      </StatusBadge>
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-kumo-subtle">
                    {agent.description || "No description provided."}
                  </p>
                  <footer
                    className={
                      "mt-3 flex flex-wrap items-center gap-1 border-t border-kumo-hairline " +
                      "pt-2.5 text-xs text-kumo-subtle"
                    }
                  >
                    {agent.latestRevision ? (
                      <>
                        <span>Revision</span>
                        <Mono>{String(agent.latestRevision)}</Mono>
                      </>
                    ) : (
                      <span>Unpublished draft</span>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>Updated {formatRelativeTime(agent.updatedAt)}</span>
                  </footer>
                </div>
              </div>
            </CardLink>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={RobotIcon}
          title="No Agents yet"
          description={
            repositoryId === "all"
              ? "Create an Agent by authoring a portable AGENT.md, then deploy it to repositories."
              : "No Agent is assigned to this repository. Choose another repository or add a deployment."
          }
          action={create}
        />
      )}
    </>
  );
}
