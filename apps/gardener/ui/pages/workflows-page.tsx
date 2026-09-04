import { Button } from "@cloudflare/kumo/components/button";
import { ArrowRightIcon, FlowArrowIcon, GitBranchIcon, PlusIcon, PlayIcon, RobotIcon, StopIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import type { WorkflowSpecV2 } from "@gardener/contracts";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import { formatRelativeTime, isEnabled } from "../lib/format";
import { defaultWorkflowInstructions } from "../lib/workflow-builder";
import { useNotifications } from "../components/notifications";
import { EmptyState, PageHeader, StatusBadge } from "../components/ui";
import type { PolicyMode, Workflow } from "../lib/types";

function latestSpec(workflow: Workflow): WorkflowSpecV2 | null {
  if (!workflow.latest_definition) return null;
  try {
    const definition = JSON.parse(workflow.latest_definition) as { schemaVersion?: string; spec?: WorkflowSpecV2 };
    return definition.schemaVersion === "v2" && definition.spec ? definition.spec : null;
  } catch {
    return null;
  }
}

function WorkflowStatuses({ workflow }: { workflow: Workflow }) {
  if (workflow.active_revision === null) return <StatusBadge tone="warning">Draft</StatusBadge>;
  const enabled = isEnabled(workflow.enabled);
  const hasNewerDraft = workflow.revision_counter > workflow.active_revision;
  return <span className="workflow-statuses">
    <StatusBadge tone={enabled ? "success" : "neutral"}>{enabled ? "Enabled" : "Disabled"}</StatusBadge>
    {hasNewerDraft ? <StatusBadge tone="warning">New draft</StatusBadge> : null}
  </span>;
}

function actionLabel(operation: string) {
  return operation === "issue.label.add" ? "Add labels" : operation === "issue.comment.create" ? "Draft replies" : operation;
}

function policyLabel(mode: PolicyMode | undefined) {
  return mode === "automatic" ? "Automatic" : mode === "approval" ? "Approval" : "Disabled";
}

export function WorkflowsPage() {
  const { state } = useGardener();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const mutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => gardenerApi.setWorkflow(id, enabled),
    onSuccess: async ({ enabled }) => {
      await queryClient.invalidateQueries({ queryKey: ["state"] });
      notify({ tone: "success", title: enabled ? "Workflow enabled" : "Workflow disabled", description: enabled ? "New matching events can create runs." : "New events will not create runs for this workflow." });
    },
    onError: (error: Error) => notify({ tone: "error", title: "Unable to update workflow", description: error.message }),
  });
  if (!state) return null;

  const effectivePolicy = (spec: WorkflowSpecV2, operation: string): PolicyMode | undefined => {
    const configured = state.policies.find((policy) => policy.operation_kind === operation)?.mode;
    return spec.capabilities.maximumMode === "approval" && configured === "automatic" ? "approval" : configured;
  };

  return <>
    <PageHeader
      title="Workflows"
      description="Choose what Gardener watches and may suggest."
      actions={<Button variant="primary" icon={PlusIcon} onClick={() => navigate("/workflows/new")}>New workflow</Button>}
    />
    {state.workflows.length ? <div className="workflow-agent-list">{state.workflows.map((workflow) => {
      const spec = latestSpec(workflow);
      const enabled = isEnabled(workflow.enabled);
      const pending = mutation.isPending && mutation.variables?.id === workflow.id;
      const repositoryNames = spec?.repositoryIds.map((repositoryId) => {
        const repository = state.repositories.find((item) => item.id === repositoryId);
        return repository ? `${repository.owner}/${repository.name}` : repositoryId;
      }) ?? [];
      const actions = spec?.triggers[0] && "actions" in spec.triggers[0] ? spec.triggers[0].actions : [];
      const proposes = spec?.capabilities.propose ?? [];
      const guided = spec ? spec.runtime.instructions === defaultWorkflowInstructions({
        suggestLabels: proposes.includes("issue.label.add"),
        suggestReply: proposes.includes("issue.comment.create"),
      }) : false;
      const titleId = `workflow-${workflow.id}-title`;
      return <article className="workflow-agent-card" aria-labelledby={titleId} key={workflow.id}>
        <header className="workflow-agent-card__header">
          <span className="agent-icon agent-icon--large"><RobotIcon size={22} weight="duotone" aria-hidden="true" /></span>
          <div className="workflow-agent-card__identity">
            <Link id={titleId} className="workflow-agent-card__title" to={`/workflows/${encodeURIComponent(workflow.id)}`}>{workflow.name}</Link>
            <p>{repositoryNames.length ? `${repositoryNames.length} ${repositoryNames.length === 1 ? "repository" : "repositories"}` : "Repository scope unavailable"} · {guided ? "Guided" : "Custom"} behavior</p>
          </div>
          <WorkflowStatuses workflow={workflow} />
          <div className="workflow-agent-card__actions">
            <Button variant="secondary" size="sm" onClick={() => navigate(`/workflows/${encodeURIComponent(workflow.id)}`)}>Manage</Button>
            {workflow.active_revision !== null ? <Button variant={enabled ? "secondary" : "primary"} size="sm" icon={enabled ? StopIcon : PlayIcon} loading={pending} onClick={() => mutation.mutate({ id: workflow.id, enabled: !enabled })}>{enabled ? "Disable" : "Enable"}</Button> : null}
          </div>
        </header>

        <div className="workflow-agent-card__rule" aria-label="Workflow behavior">
          <section><span>When</span><strong>{actions.length ? `Issue ${actions.join(" or ")}` : "GitHub issue event"}</strong></section>
          <ArrowRightIcon aria-hidden="true" />
          <section><span>Proposes</span><strong>{proposes.length ? proposes.map(actionLabel).join(" and ") : "Bounded actions"}</strong></section>
          <ArrowRightIcon aria-hidden="true" />
          <section><span>Authority</span><strong>{spec?.capabilities.maximumMode === "instance_policy" ? "Instance policy" : "Approval required"}</strong></section>
        </div>

        <footer className="workflow-agent-card__footer">
          <div className="workflow-agent-card__revision">
            <span><GitBranchIcon size={14} aria-hidden="true" />{workflow.active_revision === null ? "No active revision" : `Active v${workflow.active_revision}`}</span>
            {workflow.revision_counter > (workflow.active_revision ?? 0) ? <span>Draft v{workflow.revision_counter}</span> : null}
            <span>Updated {formatRelativeTime(workflow.updated_at)}</span>
          </div>
          <span className="workflow-policy-pills">{proposes.map((operation) => <span key={operation}>{actionLabel(operation)} <StatusBadge tone="info">{spec ? policyLabel(effectivePolicy(spec, operation)) : "Bounded"}</StatusBadge></span>)}</span>
        </footer>
      </article>;
    })}</div> : <EmptyState icon={FlowArrowIcon} title="No workflows yet" description="Create one to respond to repository events." action={<Button variant="primary" icon={PlusIcon} onClick={() => navigate("/workflows/new")}>Create workflow</Button>} />}
  </>;
}
