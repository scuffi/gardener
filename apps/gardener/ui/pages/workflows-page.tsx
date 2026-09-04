import { Button } from "@cloudflare/kumo/components/button";
import { ArrowRightIcon, BracketsCurlyIcon, ChatCircleTextIcon, FlowArrowIcon, GitBranchIcon, PlusIcon, PlayIcon, RobotIcon, StopIcon, TagIcon } from "@phosphor-icons/react";
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
      description="Agents that watch GitHub issues, gather context, and propose bounded actions."
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
      const mission = spec?.description || (proposes.includes("issue.label.add") && proposes.includes("issue.comment.create")
        ? "Triage issues with suggested labels and helpful replies."
        : proposes.includes("issue.label.add") ? "Triage issues with suggested labels." : proposes.includes("issue.comment.create") ? "Draft helpful issue replies." : "A bounded repository gardening agent.");
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
            <p>{mission}</p>
          </div>
          <WorkflowStatuses workflow={workflow} />
          <div className="workflow-agent-card__actions">
            <Button variant="secondary" size="sm" onClick={() => navigate(`/workflows/${encodeURIComponent(workflow.id)}`)}>Review</Button>
            {workflow.active_revision !== null ? <Button variant={enabled ? "secondary" : "primary"} size="sm" icon={enabled ? StopIcon : PlayIcon} loading={pending} onClick={() => mutation.mutate({ id: workflow.id, enabled: !enabled })}>{enabled ? "Disable" : "Enable"}</Button> : null}
          </div>
        </header>

        <div className="workflow-orchestration" aria-label="Workflow orchestration">
          <span><FlowArrowIcon size={15} aria-hidden="true" />GitHub event</span><ArrowRightIcon aria-hidden="true" />
          <span><BracketsCurlyIcon size={15} aria-hidden="true" />Issue context</span><ArrowRightIcon aria-hidden="true" />
          <span><RobotIcon size={15} aria-hidden="true" />Workers AI</span><ArrowRightIcon aria-hidden="true" />
          <span>{proposes.includes("issue.label.add") ? <TagIcon size={15} aria-hidden="true" /> : <ChatCircleTextIcon size={15} aria-hidden="true" />}Typed proposals</span>
        </div>

        <div className="workflow-agent-card__grid">
          <section><span>Watches</span><strong>{actions.length ? `Issues ${actions.join(" or ")}` : "GitHub issues"}</strong><small>{repositoryNames.length ? `${repositoryNames.length} ${repositoryNames.length === 1 ? "repository" : "repositories"}` : "Explicit repository scope"}</small></section>
          <section><span>Context</span><strong>Issue content</strong><small>Title, body, labels, author, and signed event metadata</small></section>
          <section><span>Model behavior</span><strong>{guided ? "Guided instructions" : "Custom instructions"}</strong><small>{spec?.runtime.instructions || "Pinned agent instructions"}</small></section>
          <section><span>Can propose</span><strong>{proposes.length ? proposes.map(actionLabel).join(" · ") : "Bounded actions"}</strong><small>Never executes outside these abilities</small></section>
        </div>

        <div className="workflow-agent-card__authority">
          <span><strong>Authority</strong><small>{spec?.capabilities.maximumMode === "instance_policy" ? "Follows instance policy" : "Approval required"}</small></span>
          <span className="workflow-policy-pills">{proposes.map((operation) => <span key={operation}>{actionLabel(operation)} <StatusBadge tone="info">{spec ? policyLabel(effectivePolicy(spec, operation)) : "Bounded"}</StatusBadge></span>)}</span>
        </div>

        <footer className="workflow-agent-card__footer">
          <span><GitBranchIcon size={14} aria-hidden="true" />{workflow.active_revision === null ? "No active revision" : `Active v${workflow.active_revision}`}</span>
          {workflow.revision_counter > (workflow.active_revision ?? 0) ? <span>Draft v{workflow.revision_counter}</span> : null}
          <span>Latest v{workflow.revision_counter || workflow.version}</span>
          <span>Updated {formatRelativeTime(workflow.updated_at)}</span>
          {!guided && spec ? <span className="workflow-agent-card__custom">Custom instructions</span> : null}
        </footer>
      </article>;
    })}</div> : <EmptyState icon={FlowArrowIcon} title="No workflow agents yet" description="Create an agent to watch repository events, gather context, and propose safe actions." action={<Button variant="primary" icon={PlusIcon} onClick={() => navigate("/workflows/new")}>Create workflow</Button>} />}
  </>;
}
