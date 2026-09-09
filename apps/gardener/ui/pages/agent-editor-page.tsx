import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { CheckCircleIcon, FloppyDiskIcon, FlaskIcon, ShieldCheckIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import type { AgentCapabilityReview, AgentValidation } from "../lib/types";
import { useNotifications } from "../components/notifications";
import { ErrorState, LoadingState, PageHeader, SectionHeader, StatusBadge, Surface } from "../components/ui";

const starter = `---
schema: gardener.agent/v1
name: Issue gardener
description: Reviews newly opened issues
triggers:
  - github.issue.opened
repositories:
  - this
capabilities:
  observation:
    - github.issue.read
  workspace: []
  effects: []
authority-ceiling: approval
limits:
  max-turns: 4
  max-tool-calls: 10
  max-parallel-tasks: 3
---
Read the issue carefully. Summarize what is needed and ask for clarification when important context is missing.
`;

function capabilityName(value: string | { capability: string }) { return typeof value === "string" ? value : value.capability; }
function CapabilityReview({ review }: { review?: AgentCapabilityReview }) {
  const groups = review ? [
    ["Observation", review.observation], ["Workspace", review.workspace.map(capabilityName)], ["Persistent effects", review.effects.map(capabilityName)],
  ] as const : [];
  return <div className="capability-review">{groups.length ? groups.map(([label, values]) => <section key={label}><h3>{label}</h3>{values.length ? <ul>{values.map((value) => <li key={value}><code>{value}</code>{label === "Persistent effects" ? <StatusBadge tone="warning">Policy checked</StatusBadge> : null}</li>)}</ul> : <p>None requested</p>}</section>) : <p className="muted-copy">Validate the source to review its exact requested capabilities.</p>}</div>;
}

export function AgentEditorPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const { state } = useGardener();
  const detail = useQuery({ queryKey: ["agent", id], queryFn: () => gardenerApi.agent(id!), enabled: editing });
  const [source, setSource] = useState(starter);
  const [validation, setValidation] = useState<AgentValidation | null>(null);
  const [simulation, setSimulation] = useState<string | null>(null);
  const repositories = (state?.repositories ?? []).filter((repository) => Boolean(repository.active));
  const [thisRepositoryId, setThisRepositoryId] = useState("");
  useEffect(() => {
    const stored = detail.data?.draft?.sourceMd ?? detail.data?.sourceMd;
    if (stored) setSource(stored);
    const context = detail.data?.draft?.thisRepositoryId ?? detail.data?.thisRepositoryId;
    if (context) setThisRepositoryId(context);
  }, [detail.data]);
  useEffect(() => {
    if (!thisRepositoryId && repositories[0]) setThisRepositoryId(repositories[0].id);
  }, [repositories, thisRepositoryId]);
  const storedSource = detail.data?.draft?.sourceMd ?? detail.data?.sourceMd;
  const storedRepositoryId = detail.data?.draft?.thisRepositoryId ?? detail.data?.thisRepositoryId;
  const dirty = !editing || source !== (storedSource ?? "") || thisRepositoryId !== (storedRepositoryId ?? repositories[0]?.id ?? "");
  const validationErrors = useMemo(() => validation?.diagnostics.filter((item) => item.severity !== "warning") ?? [], [validation]);

  const validate = useMutation({ mutationFn: () => gardenerApi.validateAgent(source, id, thisRepositoryId || undefined), onSuccess: setValidation, onError: (error: Error) => notify({ tone: "error", title: "Validation failed", description: error.message }) });
  const simulate = useMutation({ mutationFn: () => gardenerApi.simulateAgent(source, id, thisRepositoryId || undefined), onSuccess: (result) => setSimulation(result.summary || result.status), onError: (error: Error) => notify({ tone: "error", title: "Simulation failed", description: error.message }) });
  const save = useMutation({ mutationFn: async () => editing ? gardenerApi.saveAgentDraft(id!, source, thisRepositoryId || undefined).then(() => id!) : gardenerApi.createAgent(source, thisRepositoryId || undefined).then(({ agent }) => agent.id), onSuccess: async (agentId) => { await queryClient.invalidateQueries({ queryKey: ["agents"] }); notify({ tone: "success", title: "Draft saved", description: "Saving a draft does not grant runtime authority." }); navigate(`/agents/${encodeURIComponent(agentId)}/draft`, { replace: true }); }, onError: (error: Error) => notify({ tone: "error", title: "Draft was not saved", description: error.message }) });
  const publish = useMutation({ mutationFn: async () => { let agentId = id; if (!agentId) agentId = (await gardenerApi.createAgent(source, thisRepositoryId || undefined)).agent.id; const result = await gardenerApi.publishAgent(agentId, source, thisRepositoryId || undefined); return { agentId, revision: result.revision }; }, onSuccess: async ({ agentId, revision }) => { await queryClient.invalidateQueries({ queryKey: ["agents"] }); notify({ tone: "success", title: `Revision ${revision} published paused`, description: "Activate it separately, then enable the Agent when you are ready." }); navigate(`/agents/${encodeURIComponent(agentId)}`); }, onError: (error: Error) => notify({ tone: "error", title: "Revision was not published", description: error.message }) });

  if (detail.isLoading) return <LoadingState label="Loading Agent draft" />;
  if (detail.error) return <ErrorState message={(detail.error as Error).message} onRetry={() => void detail.refetch()} />;
  return <>
    <PageHeader title={editing ? `Edit ${detail.data?.agent.name ?? "Agent"}` : "New Agent"} description="Author portable behavior in AGENT.md, then validate capabilities and test safely before publishing a paused immutable revision." actions={<Button variant="secondary" onClick={() => navigate(editing ? `/agents/${encodeURIComponent(id!)}` : "/agents")}>Cancel</Button>} />
    <div className="agent-editor-layout">
      <Surface className="agent-source-panel" padded={false}><SectionHeader title="AGENT.md" description="Instructions guide judgment; they cannot grant authority, secrets, network access, or policy changes." /><div className="agent-source-editor"><label htmlFor="agent-this-repository">Repository context for <code>this</code></label><select id="agent-this-repository" value={thisRepositoryId} onChange={(event) => { setThisRepositoryId(event.target.value); setValidation(null); setSimulation(null); }} disabled={!repositories.length}>{!repositories.length ? <option value="">No active repositories</option> : repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.owner}/{repository.name} · {repository.id}</option>)}</select><label htmlFor="agent-source">Agent package source</label><textarea id="agent-source" value={source} spellCheck={false} onChange={(event) => { setSource(event.target.value); setValidation(null); setSimulation(null); }} aria-describedby="agent-source-help" /><p id="agent-source-help">Unknown fields and capabilities fail closed. Repository <code>this</code> is resolved to an immutable repository ID when compiled.</p></div></Surface>
      <aside className="agent-review-panel" aria-label="Agent review">
        <Surface padded={false}><SectionHeader title="Capability review" description="Omitted capabilities mean none." /><CapabilityReview {...(validation?.capabilities ? { review: validation.capabilities } : {})} /></Surface>
        <Surface><div className="agent-review-actions"><Button variant="secondary" icon={ShieldCheckIcon} loading={validate.isPending} onClick={() => validate.mutate()}>Validate</Button><Button variant="secondary" icon={FlaskIcon} loading={simulate.isPending} onClick={() => simulate.mutate()}>Simulate safely</Button></div>
          {validation ? <div className="validation-result" role="status"><strong>{validation.valid && !validationErrors.length ? <><CheckCircleIcon size={16} /> Valid Agent source</> : `${validationErrors.length} validation ${validationErrors.length === 1 ? "error" : "errors"}`}</strong>{validation.diagnostics.length ? <ul>{validation.diagnostics.map((item, index) => <li key={`${item.code}-${index}`}><code>{item.path || item.code}</code> {item.message}</li>)}</ul> : null}</div> : null}
          {simulation ? <Banner variant="secondary" title="Simulation result" description={simulation} /> : null}
        </Surface>
        <Surface><h2>Publication boundary</h2><p className="muted-copy">Publishing creates an immutable paused revision. It does not activate the revision or enable the Agent.</p><div className="agent-publish-actions"><Button variant="secondary" icon={FloppyDiskIcon} loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>Save draft</Button><Button variant="primary" icon={UploadSimpleIcon} loading={publish.isPending} disabled={!validation?.publishable} onClick={() => publish.mutate()}>Publish paused</Button></div></Surface>
      </aside>
    </div>
  </>;
}
