import { PlusIcon, RobotIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { gardenerApi } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "../components/ui";

export function AgentsPage() {
  const query = useQuery({ queryKey: ["agents"], queryFn: gardenerApi.agents });
  const agents = query.data?.agents ?? [];
  const create = <Link className="agent-primary-link" to="/agents/new"><PlusIcon size={16} aria-hidden="true" />New Agent</Link>;
  return <>
    <PageHeader title="Agents" description="Portable AGENT.md packages define behavior. Capabilities, repository scope, policies, and activation remain separate authority layers." actions={create} />
    {query.isLoading ? <LoadingState label="Loading Agents" /> : query.error ? <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} /> : agents.length ? <div className="agent-grid">{agents.map((agent) => <article className="agent-card" key={agent.id}>
      <div className="agent-card__icon"><RobotIcon size={20} aria-hidden="true" /></div>
      <div className="agent-card__copy"><div className="agent-card__heading"><h2><Link to={`/agents/${encodeURIComponent(agent.id)}`}>{agent.name}</Link></h2><span className="agent-statuses"><StatusBadge tone={agent.lifecycle === "active" ? "success" : "warning"}>{agent.lifecycle === "active" ? "Active revision" : agent.lifecycle}</StatusBadge><StatusBadge tone={agent.enabled ? "success" : "neutral"}>{agent.enabled ? "Enabled" : "Disabled"}</StatusBadge></span></div>
        <p>{agent.description || "No description provided."}</p><footer><span>{agent.latestRevision ? `Revision ${agent.latestRevision}` : "Unpublished draft"}</span><span>Updated {formatRelativeTime(agent.updatedAt)}</span></footer>
      </div>
    </article>)}</div> : <EmptyState icon={RobotIcon} title="No Agents yet" description="Create an Agent by authoring a portable AGENT.md. New Agents remain disabled until you publish, activate, and enable them." action={create} />}
  </>;
}
