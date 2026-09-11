import { PlusIcon, RobotIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { gardenerApi } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import {
  CardSkeleton,
  EmptyState,
  ErrorState,
  Link,
  LinkButton,
  Mono,
  PageHeader,
  Panel,
  StatusBadge,
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
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          {agents.map((agent) => (
            <Panel
              key={agent.id}
              as="article"
              className="transition-colors hover:border-kumo-line"
            >
              <div className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)] gap-3">
                <span
                  className={
                    "grid size-10 place-items-center rounded-md bg-kumo-info/10 text-kumo-info"
                  }
                >
                  <RobotIcon size={20} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-3 max-sm:flex-col">
                    <h2 className="text-base font-semibold text-kumo-strong">
                      <Link href={`/agents/${encodeURIComponent(agent.id)}`}>{agent.name}</Link>
                    </h2>
                    <span className="flex flex-wrap justify-end gap-1 max-sm:justify-start">
                      <StatusBadge tone={agent.lifecycle === "active" ? "success" : "warning"}>
                        {agent.lifecycle === "active" ? "Active revision" : agent.lifecycle}
                      </StatusBadge>
                      <StatusBadge tone={agent.enabled ? "success" : "neutral"}>
                        {agent.enabled ? "Enabled" : "Disabled"}
                      </StatusBadge>
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-kumo-subtle">
                    {agent.description || "No description provided."}
                  </p>
                  <footer
                    className={
                      "mt-3 flex flex-wrap justify-between gap-2 border-t border-kumo-hairline " +
                      "pt-2.5 text-xs text-kumo-subtle"
                    }
                  >
                    {agent.latestRevision ? (
                      <span className="flex items-center gap-1">
                        Revision <Mono>{String(agent.latestRevision)}</Mono>
                      </span>
                    ) : (
                      <span>Unpublished draft</span>
                    )}
                    <span>Updated {formatRelativeTime(agent.updatedAt)}</span>
                  </footer>
                </div>
              </div>
            </Panel>
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
