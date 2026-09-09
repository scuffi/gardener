import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { CheckCircleIcon, PencilSimpleIcon, PlayIcon, PowerIcon, RobotIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { gardenerApi } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { useNotifications } from "../components/notifications";
import { ErrorState, LoadingState, PageHeader, SectionHeader, StatusBadge, Surface } from "../components/ui";

export function AgentDetailPage() {
  const { id, revision: revisionParam } = useParams();
  const navigate = useNavigate();
  const revisionNumber = revisionParam ? Number(revisionParam) : null;
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const detail = useQuery({ queryKey: ["agent", id], queryFn: () => gardenerApi.agent(id!), enabled: Boolean(id) });
  const revision = useQuery({ queryKey: ["agent", id, "revision", revisionNumber], queryFn: () => gardenerApi.agentRevision(id!, revisionNumber!), enabled: Boolean(id && revisionNumber) });
  const activate = useMutation({ mutationFn: (number: number) => gardenerApi.activateAgentRevision(id!, number), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["agent", id] }); notify({ tone: "success", title: "Revision activated", description: "The Agent remains disabled until enabled separately." }); }, onError: (error: Error) => notify({ tone: "error", title: "Revision was not activated", description: error.message }) });
  const enable = useMutation({ mutationFn: (enabled: boolean) => gardenerApi.setAgentEnabled(id!, enabled), onSuccess: async ({ enabled }) => { await queryClient.invalidateQueries({ queryKey: ["agent", id] }); await queryClient.invalidateQueries({ queryKey: ["agents"] }); notify({ tone: "success", title: enabled ? "Agent enabled" : "Agent disabled" }); }, onError: (error: Error) => notify({ tone: "error", title: "Agent status was not changed", description: error.message }) });
  if (detail.isLoading) return <LoadingState label="Loading Agent" />;
  if (detail.error || !detail.data) return <ErrorState message={(detail.error as Error)?.message ?? "Agent was not found."} onRetry={() => void detail.refetch()} />;
  const { agent, revisions, draft } = detail.data;
  const selected = revisionNumber ? revisions.find((item) => item.revision === revisionNumber) : null;
  return <>
    <PageHeader title={revisionNumber ? `${agent.name} · revision ${revisionNumber}` : agent.name} description={agent.description || "Agent behavior and immutable revision history."} actions={<><Button variant="secondary" icon={PencilSimpleIcon} onClick={() => navigate(`/agents/${encodeURIComponent(agent.id)}/draft`)}>{draft ? "Edit draft" : "Create draft"}</Button>{!revisionNumber ? <Button variant={agent.enabled ? "secondary" : "primary"} icon={PowerIcon} loading={enable.isPending} disabled={!agent.activeRevision} onClick={() => enable.mutate(!agent.enabled)}>{agent.enabled ? "Disable Agent" : "Enable Agent"}</Button> : null}</>} />
    <div className="agent-detail-summary"><Surface><span className="agent-detail-icon"><RobotIcon size={22} /></span><dl><div><dt>Active revision</dt><dd>{agent.activeRevision ?? "None"}</dd></div><div><dt>Runtime</dt><dd><StatusBadge tone={agent.enabled ? "success" : "neutral"}>{agent.enabled ? "Enabled" : "Disabled"}</StatusBadge></dd></div><div><dt>Draft</dt><dd>{draft ? "Unpublished changes" : "None"}</dd></div></dl></Surface>
      <Banner variant="secondary" title="Authority remains layered" description="Instructions do not override compiled capabilities, instance policy, temporary grants, exact-effect approval, or Connect live-state checks." />
    </div>
    {revisionNumber ? <Surface padded={false}><SectionHeader title={`Immutable revision ${revisionNumber}`} description={selected ? `Published ${formatRelativeTime(selected.publishedAt)}` : "Published Agent source"} actions={selected && !selected.active ? <Button variant="primary" icon={PlayIcon} loading={activate.isPending} onClick={() => activate.mutate(revisionNumber)}>Activate revision</Button> : selected?.active ? <StatusBadge tone="success">Active</StatusBadge> : null} />{revision.isLoading ? <LoadingState label="Loading revision source" /> : revision.error ? <ErrorState message={(revision.error as Error).message} /> : <pre className="agent-source-readonly"><code>{revision.data?.sourceMd ?? "Source is unavailable."}</code></pre>}</Surface> : <Surface padded={false}><SectionHeader title="Revisions" description="Publishing creates immutable paused history. Activation and enablement are separate owner actions." />{revisions.length ? <div className="revision-list">{revisions.map((item) => <article key={item.id}><div><strong>Revision {item.revision}</strong><span>Published {formatRelativeTime(item.publishedAt)}{item.publishedBy ? ` by ${item.publishedBy}` : ""}</span></div><code title={item.sourceHash}>{item.sourceHash.slice(0, 12)}</code><div>{item.active ? <StatusBadge tone="success">Active</StatusBadge> : <Button variant="secondary" onClick={() => navigate(`/agents/${encodeURIComponent(agent.id)}/revisions/${item.revision}`)}>Review</Button>}</div></article>)}</div> : <div className="agent-empty-section"><p>No immutable revision has been published. The Agent cannot run.</p></div>}</Surface>}
  </>;
}
