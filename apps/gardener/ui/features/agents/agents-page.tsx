import { PlusIcon, RobotIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
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
  StatusBadge,
  statusTone,
} from "../../primitives";

export function AgentsPage() {
  const query = useQuery({ queryKey: queryKeys.agents, queryFn: gardenerApi.agents });
  const agents = query.data?.agents ?? [];
  const create = (
    <LinkButton href="/agents/new" icon={PlusIcon}>
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
      {query.isLoading ? (
        <CardSkeleton />
      ) : query.error ? (
        <ErrorState
          message={(query.error as Error).message}
          onRetry={() => void query.refetch()}
        />
      ) : agents.length ? (
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          {agents.map((agent) => (
            <CardLink
              key={agent.id}
              href={`/agents/${encodeURIComponent(agent.id)}`}
              label={`Open Agent ${agent.name}`}
            >
              <div className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)] gap-3">
                <span
                  className={
                    "grid size-10 place-items-center rounded-md bg-kumo-brand/10 text-kumo-brand"
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
                      <StatusBadge tone={statusTone(agent.enabled ? "enabled" : "disabled")}>
                        {agent.enabled ? "Enabled" : "Disabled"}
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
          ))}
        </div>
      ) : (
        <EmptyState
          icon={RobotIcon}
          title="No Agents yet"
          description={
            "Create an Agent by authoring a portable AGENT.md. New Agents remain disabled until " +
            "you publish, activate, and enable them."
          }
          action={create}
        />
      )}
    </>
  );
}
