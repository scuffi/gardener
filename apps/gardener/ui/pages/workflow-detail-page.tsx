import { Button } from "@cloudflare/kumo/components/button";
import { ArrowLeftIcon, ArrowRightIcon, BracketsCurlyIcon, ChatCircleTextIcon, CheckCircleIcon, FlowArrowIcon, PencilSimpleIcon, PlayIcon, RobotIcon, StopIcon, TagIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { systemPromptTemplateReferences } from "@gardener/contracts";
import { useGardener } from "../app-context";
import { useNotifications } from "../components/notifications";
import { ErrorState, LoadingState, PageHeader, SectionHeader, StatusBadge, Surface } from "../components/ui";
import { gardenerApi } from "../lib/api";
import { isEnabled } from "../lib/format";
import { defaultWorkflowInstructions, workflowBuilderValuesFromSpec } from "../lib/workflow-builder";

function actionLabel(kind: string) {
  return kind === "issue.label.add" ? "Suggest labels" : kind === "issue.comment.create" ? "Suggest a reply" : kind;
}

export function WorkflowDetailPage() {
  const { id = "", revision: requestedRevisionParam } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { state } = useGardener();
  const { notify } = useNotifications();
  const detailQuery = useQuery({ queryKey: ["workflow", id], queryFn: () => gardenerApi.workflow(id), enabled: Boolean(id) });
  const requestedRevision = requestedRevisionParam === undefined ? null : Number(requestedRevisionParam);
  const invalidRequestedRevision = requestedRevision !== null && (!Number.isInteger(requestedRevision) || requestedRevision < 1);
  const selectedRevision = invalidRequestedRevision ? undefined : requestedRevision ?? detailQuery.data?.latestRevision;
  const revisionQuery = useQuery({
    queryKey: ["workflow-revision", id, selectedRevision],
    queryFn: () => gardenerApi.workflowRevision(id, selectedRevision!),
    enabled: Boolean(id && selectedRevision),
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workflow", id] }),
      queryClient.invalidateQueries({ queryKey: ["workflow-revision", id] }),
      queryClient.invalidateQueries({ queryKey: ["state"] }),
    ]);
  };
  const activation = useMutation({
    mutationFn: (revision: number) => gardenerApi.activateWorkflowRevision(id, revision),
    onSuccess: async () => {
      await refresh();
      notify({ tone: "success", title: "Revision activated", description: isEnabled(detailQuery.data?.workflow.enabled ?? false) ? "The workflow remains enabled with this revision." : "Enable the workflow when you want it to receive new events." });
    },
    onError: (error: Error) => notify({ tone: "error", title: "Unable to activate workflow", description: error.message }),
  });
  const status = useMutation({
    mutationFn: (enabled: boolean) => gardenerApi.setWorkflow(id, enabled),
    onSuccess: async ({ enabled }) => {
      await refresh();
      notify({ tone: "success", title: enabled ? "Workflow enabled" : "Workflow disabled", description: enabled ? "New matching events can create runs." : "New events will not create runs." });
    },
    onError: (error: Error) => notify({ tone: "error", title: "Unable to update workflow", description: error.message }),
  });

  if (invalidRequestedRevision) return <ErrorState title="Invalid workflow revision" message="Choose a positive revision number." />;
  if (detailQuery.isLoading || revisionQuery.isLoading) return <LoadingState label="Loading workflow" />;
  if (detailQuery.error) return <ErrorState title="Unable to load workflow" message={(detailQuery.error as Error).message} onRetry={() => void detailQuery.refetch()} />;
  if (revisionQuery.error) return <ErrorState title="Unable to load workflow revision" message={(revisionQuery.error as Error).message} onRetry={() => void revisionQuery.refetch()} />;
  const detail = detailQuery.data;
  const revision = revisionQuery.data?.revision;
  if (!detail || !revision) return <ErrorState title="Workflow not found" message="This workflow or its latest revision is unavailable." />;

  const workflow = detail.workflow;
  const spec = revision.definition.spec;
  const enabled = isEnabled(workflow.enabled);
  const viewingLatest = revision.revision === detail.latestRevision;
  const editable = viewingLatest && workflowBuilderValuesFromSpec(spec) !== null;
  const validation = revisionQuery.data!.currentValidation;
  const hasCompiledPlan = revision.compiledPlan !== null;
  const canActivate = validation.activatable && hasCompiledPlan;
  const active = workflow.active_revision !== null;
  const revisionIsActive = workflow.active_revision === revision.revision;
  const repositoryNames = spec.repositoryIds.map((repositoryId) => {
    const repository = state?.repositories.find((item) => item.id === repositoryId);
    return repository ? `${repository.owner}/${repository.name}` : repositoryId;
  });
  const actions = spec.triggers[0]?.kind === "github.issue" ? spec.triggers[0].actions : [];
  const proposes = spec.capabilities.propose;
  const guidedInstructions = spec.runtime.instructions === defaultWorkflowInstructions({ suggestLabels: proposes.includes("issue.label.add"), suggestReply: proposes.includes("issue.comment.create") });
  const promptReferences = systemPromptTemplateReferences(spec.runtime.instructions);
  const effectiveMode = (operation: string) => {
    const configured = state?.policies.find((policy) => policy.operation_kind === operation)?.mode;
    return spec.capabilities.maximumMode === "approval" && configured === "automatic" ? "approval" : configured;
  };
  const modeLabel = (mode: string | undefined) => mode === "automatic" ? "Automatic" : mode === "approval" ? "Approval" : "Disabled";

  return <>
    <PageHeader
      title={workflow.name}
      description={viewingLatest ? "Review the latest draft, activate it, then choose when it should receive new events." : `Review saved revision ${revision.revision} and activate it if you want to restore this definition.`}
      actions={<Button variant="secondary" icon={ArrowLeftIcon} onClick={() => navigate("/workflows")}>Back to workflows</Button>}
    />

    <Surface padded={false}>
      <SectionHeader
        title={`Revision ${revision.revision}`}
        description={revisionIsActive ? "This is the active revision." : viewingLatest ? active ? `Revision ${workflow.active_revision} remains active until you activate this draft.` : "This workflow is still a draft." : `Revision ${detail.latestRevision} is the latest saved revision.`}
        actions={<div className="workflow-detail__badges">
          <StatusBadge tone={revisionIsActive ? "success" : "warning"}>{revisionIsActive ? "Active revision" : viewingLatest ? "Draft" : "Saved revision"}</StatusBadge>
          <StatusBadge tone={enabled ? "success" : "neutral"}>{enabled ? "Workflow enabled" : "Workflow disabled"}</StatusBadge>
        </div>}
      />
      <div className="workflow-detail__profile">
        <div className="workflow-detail__main">
          <div className="workflow-profile-heading"><span className="agent-icon agent-icon--large"><RobotIcon size={22} weight="duotone" aria-hidden="true" /></span><span><strong>{spec.description || "Repository gardening agent"}</strong><small>{guidedInstructions ? "Guided behavior" : "Custom agent instructions"} · Workers AI deployment model</small></span></div>
          <div className="workflow-orchestration" aria-label="Agent orchestration">
            <span><FlowArrowIcon size={15} aria-hidden="true" />GitHub event</span><ArrowRightIcon aria-hidden="true" />
            <span><BracketsCurlyIcon size={15} aria-hidden="true" />Issue context</span><ArrowRightIcon aria-hidden="true" />
            <span><RobotIcon size={15} aria-hidden="true" />Workers AI</span><ArrowRightIcon aria-hidden="true" />
            <span>{proposes.includes("issue.label.add") ? <TagIcon size={15} aria-hidden="true" /> : <ChatCircleTextIcon size={15} aria-hidden="true" />}Typed proposals</span>
          </div>

          <section className="workflow-profile-section">
            <h3>Run context</h3>
            <dl className="workflow-detail__summary">
              <div><dt>Watches</dt><dd>Issues {actions.join(" or ")}</dd></div>
              <div><dt>Repositories</dt><dd>{repositoryNames.join(", ")}</dd></div>
              <div><dt>Model sees</dt><dd>Issue title, body, labels, author, number, repository, and event action</dd></div>
            </dl>
          </section>

          <section className="workflow-profile-section">
            <div className="workflow-profile-section__heading"><span><h3>Model behavior</h3><p>Instructions guide the agent; they never expand its abilities or authority.</p></span><StatusBadge tone={guidedInstructions ? "neutral" : "info"}>{guidedInstructions ? "Guided instructions" : "Custom instructions"}</StatusBadge></div>
            <pre className="workflow-instructions-preview">{spec.runtime.instructions}</pre>
            {promptReferences.length ? <div className="workflow-prompt-context"><strong>Trusted metadata used</strong><span>{promptReferences.map((reference) => <code key={reference}>{`{{${reference}}}`}</code>)}</span></div> : null}
            <p className="workflow-trust-note"><CheckCircleIcon size={15} aria-hidden="true" />Issue content remains lower-trust user context, not system instructions.</p>
          </section>

          <section className="workflow-profile-section">
            <h3>Abilities</h3>
            <div className="workflow-ability-list">{proposes.map((operation) => <div key={operation}><span className="workflow-ability-list__icon">{operation === "issue.label.add" ? <TagIcon size={17} aria-hidden="true" /> : <ChatCircleTextIcon size={17} aria-hidden="true" />}</span><span><strong>{actionLabel(operation)}</strong><small>Typed, bounded proposal</small></span><StatusBadge tone="info">{modeLabel(effectiveMode(operation))}</StatusBadge></div>)}</div>
          </section>
        </div>

        <aside className="workflow-detail__lifecycle" aria-label="Workflow authority and lifecycle">
          {canActivate ? <div className="workflow-detail__ready"><CheckCircleIcon size={18} aria-hidden="true" /><span><strong>{revisionIsActive ? "Active definition" : "Ready to activate"}</strong><small>{revisionIsActive ? "This revision still passes current validation." : "Repositories, runtime, instructions, and operation limits are available."}</small></span></div> : validation.activatable ? <div className="inline-error" role="alert"><p>This revision has no immutable compiled plan. Save it as a new draft before activation.</p></div> : <div className="inline-error" role="alert">{validation.diagnostics.map((item) => <p key={`${item.path}-${item.code}`}>{item.message}</p>)}</div>}
          <div className="workflow-lifecycle-card"><span>Maximum authority</span><strong>{spec.capabilities.maximumMode === "approval" ? "Approval required" : "Follow instance policy"}</strong><p>Instructions cannot grant additional operations or override instance policy.</p></div>
          <dl className="workflow-lifecycle-facts"><div><dt>Viewing</dt><dd>Revision {revision.revision}</dd></div><div><dt>Active</dt><dd>{workflow.active_revision ? `Revision ${workflow.active_revision}` : "None"}</dd></div><div><dt>Latest</dt><dd>Revision {detail.latestRevision}</dd></div><div><dt>Scope</dt><dd>{repositoryNames.length} {repositoryNames.length === 1 ? "repository" : "repositories"}</dd></div></dl>
        </aside>
      </div>
      <div className="workflow-detail__actions">
        {editable ? <Button variant="secondary" icon={PencilSimpleIcon} onClick={() => navigate(`/workflows/${encodeURIComponent(id)}/edit`)}>Edit as new draft</Button> : null}
        {!revisionIsActive ? <Button variant="primary" loading={activation.isPending} disabled={!canActivate} onClick={() => activation.mutate(revision.revision)}>Activate revision {revision.revision}</Button> : null}
        {active ? <Button variant={enabled ? "secondary" : "primary"} icon={enabled ? StopIcon : PlayIcon} loading={status.isPending} onClick={() => status.mutate(!enabled)}>{enabled ? "Disable workflow" : "Enable workflow"}</Button> : null}
        <span>{!active ? "Activation does not enable the workflow." : enabled && !revisionIsActive ? "Activating this revision changes behavior for new matching events immediately." : enabled ? `Active revision ${workflow.active_revision} can create new runs.` : "The active workflow is not receiving events."}</span>
      </div>
    </Surface>
  </>;
}
