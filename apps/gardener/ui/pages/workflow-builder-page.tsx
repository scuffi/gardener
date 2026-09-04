import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowLeftIcon, ArrowRightIcon, BracketsCurlyIcon, CheckIcon, ChatCircleTextIcon, GitBranchIcon, RobotIcon, ShieldCheckIcon, SparkleIcon, TagIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useGardener } from "../app-context";
import { useNotifications } from "../components/notifications";
import { ErrorState, LoadingState, PageHeader, SectionHeader, StatusBadge, Surface } from "../components/ui";
import { systemPromptVariables } from "@gardener/contracts";
import { gardenerApi } from "../lib/api";
import { buildWorkflowSpec, defaultWorkflowInstructions, initialWorkflowValues, workflowBuilderError, workflowBuilderValuesFromSpec, type WorkflowBuilderValues } from "../lib/workflow-builder";
import { isEnabled } from "../lib/format";

function Choice({ checked, onChange, title, description, icon }: { checked: boolean; onChange: (checked: boolean) => void; title: string; description?: string | undefined; icon?: ReactNode }) {
  return <label className={`builder-choice${checked ? " builder-choice--selected" : ""}`}>
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span className="builder-choice__check" aria-hidden="true">{checked ? <CheckIcon size={11} weight="bold" /> : null}</span>
    <span className="builder-choice__copy">{icon ? <span className="builder-choice__icon">{icon}</span> : null}<span><strong>{title}</strong>{description ? <small>{description}</small> : null}</span></span>
  </label>;
}

function modeLabel(mode: string | undefined) {
  return mode === "automatic" ? "Automatic" : mode === "approval" ? "Approval" : "Disabled";
}

export function WorkflowBuilderPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const { state } = useGardener();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const [values, setValues] = useState<WorkflowBuilderValues>(initialWorkflowValues);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [hydratedRevision, setHydratedRevision] = useState<number | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const editQuery = useQuery({
    queryKey: ["workflow-edit", id],
    queryFn: async () => {
      const detail = await gardenerApi.workflow(id!);
      const revision = await gardenerApi.workflowRevision(id!, detail.latestRevision);
      return { detail, revision };
    },
    enabled: editing,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    gcTime: 0,
  });
  const editValues = editQuery.data ? workflowBuilderValuesFromSpec(editQuery.data.revision.revision.definition.spec) : null;
  useEffect(() => {
    if (!editQuery.data || !editValues) return;
    setValues(editValues);
    setHydratedRevision(editQuery.data.detail.latestRevision);
  }, [editQuery.data]);

  const selectableRepositories = state?.repositories.filter((repository) => isEnabled(repository.active) || values.repositoryIds.includes(repository.id)) ?? [];
  const formError = workflowBuilderError(values);
  const spec = useMemo(() => buildWorkflowSpec(values), [values]);
  const unchanged = Boolean(editing && editQuery.data && editQuery.data.revision.revision.compiledPlan !== null && JSON.stringify(spec) === JSON.stringify(editQuery.data.revision.revision.definition.spec));
  const submissionError = formError ?? (unchanged ? "Change at least one setting before saving a new draft." : null);
  const nameError = formError === "Give this workflow a name." ? formError : null;
  const eventError = formError === "Choose at least one issue event." ? formError : null;
  const repositoryError = formError === "Choose at least one repository." ? formError : null;
  const outcomeError = formError === "Choose at least one outcome." ? formError : null;
  const promptError = formError && !nameError && !eventError && !repositoryError && !outcomeError ? formError : null;
  const customInstructions = values.instructions !== defaultWorkflowInstructions(values);
  useEffect(() => {
    if (customInstructions || promptError) setAdvancedOpen(true);
  }, [customInstructions, promptError]);
  const instructionExample = values.instructions.replace(/{{\s*([^{}]*?)\s*}}/g, (placeholder, id: string) => systemPromptVariables.find((variable) => variable.id === id.trim())?.example ?? placeholder);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const localError = workflowBuilderError(values);
      if (localError) throw new Error(localError);
      if (unchanged) throw new Error("Change at least one setting before saving a new draft.");
      const validation = await gardenerApi.validateWorkflow(spec);
      if (!validation.valid) {
        setDiagnostics(validation.diagnostics.map((item) => item.message));
        throw new Error("Review the workflow settings below.");
      }
      setDiagnostics([]);
      const result = editing
        ? await gardenerApi.createWorkflowRevision(id!, editQuery.data!.detail.latestRevision, spec)
        : await gardenerApi.createWorkflow(spec);
      return { result, activatable: validation.activatable };
    },
    onSuccess: async ({ result, activatable }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["state"] }),
        queryClient.invalidateQueries({ queryKey: ["workflow", result.workflowId] }),
        queryClient.invalidateQueries({ queryKey: ["workflow-revision", result.workflowId] }),
      ]);
      notify({
        tone: result.duplicate ? "info" : "success",
        title: result.duplicate ? "No new draft created" : editing ? "Draft revision created" : "Draft created",
        description: result.duplicate
          ? `These settings already exist as revision ${result.revision.revision}. Review that saved revision to restore it.`
          : activatable ? "Review and activate it when you are ready." : "Draft saved. Resolve its validation checks before activation.",
      });
      navigate(result.duplicate
        ? `/workflows/${encodeURIComponent(result.workflowId)}/revisions/${result.revision.revision}`
        : `/workflows/${encodeURIComponent(result.workflowId)}`);
    },
    onError: (error: Error) => notify({ tone: "error", title: editing ? "Unable to create draft revision" : "Unable to create workflow", description: error.message }),
  });

  const update = <K extends keyof WorkflowBuilderValues>(key: K, value: WorkflowBuilderValues[K]) => setValues((current) => ({ ...current, [key]: value }));
  const updateOutcome = (key: "suggestLabels" | "suggestReply", value: boolean) => setValues((current) => {
    const usedDefault = current.instructions === defaultWorkflowInstructions(current);
    const next = { ...current, [key]: value };
    return { ...next, instructions: usedDefault ? defaultWorkflowInstructions(next) : current.instructions };
  });
  const insertPromptVariable = (id: string) => {
    const token = `{{${id}}}`;
    const input = promptRef.current;
    const start = input?.selectionStart ?? values.instructions.length;
    const end = input?.selectionEnd ?? start;
    update("instructions", `${values.instructions.slice(0, start)}${token}${values.instructions.slice(end)}`);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const toggleRepository = (id: string, selected: boolean) => update("repositoryIds", selected ? [...values.repositoryIds, id] : values.repositoryIds.filter((item) => item !== id));
  const effectiveMode = (operation: "issue.label.add" | "issue.comment.create") => {
    const configured = state?.policies.find((policy) => policy.operation_kind === operation)?.mode;
    return spec.capabilities.maximumMode === "approval" && configured === "automatic" ? "approval" : configured;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!saveMutation.isPending) saveMutation.mutate();
  };

  if (editing && (editQuery.isLoading || editQuery.isFetching)) return <LoadingState label="Loading workflow draft" />;
  if (editing && editQuery.error) return <ErrorState title="Unable to load workflow" message={(editQuery.error as Error).message} onRetry={() => void editQuery.refetch()} />;
  if (editing && editQuery.data && !editValues) return <ErrorState title="This workflow cannot be edited here" message="The V1 builder only edits its own issue workflow definitions. You can still review and activate this workflow." />;
  if (editing && editQuery.data && hydratedRevision !== editQuery.data.detail.latestRevision) return <LoadingState label="Preparing workflow draft" />;

  return <form onSubmit={submit} className="workflow-builder">
    <PageHeader
      title={editing ? "Edit workflow" : "New workflow"}
      description={editing ? "Update the workflow. Saving creates a new draft revision." : "Set when it runs, what it suggests, and who approves."}
      actions={<Button type="button" variant="secondary" icon={ArrowLeftIcon} onClick={() => navigate(editing ? `/workflows/${encodeURIComponent(id!)}` : "/workflows")}>{editing ? "Cancel" : "Back to workflows"}</Button>}
    />

    <ol className="builder-flow" aria-label="Workflow configuration flow">
      <li><span>1</span><strong>Trigger</strong></li>
      <ArrowRightIcon aria-hidden="true" />
      <li><span>2</span><strong>Scope</strong></li>
      <ArrowRightIcon aria-hidden="true" />
      <li><span>3</span><strong>Behavior</strong></li>
      <ArrowRightIcon aria-hidden="true" />
      <li><span>4</span><strong>Approval</strong></li>
    </ol>

    <div className="workflow-builder__layout">
      <div className="workflow-builder__form">
        <Surface padded={false}>
          <SectionHeader title="Name" />
          <div className="builder-section"><Input id="workflow-name" label="Workflow name" value={values.name} onChange={(event) => update("name", event.target.value)} placeholder="Issue helper" maxLength={100} disabled={editing} autoFocus={!editing} aria-invalid={Boolean(nameError)} aria-describedby={nameError ? "workflow-name-error" : editing ? "workflow-name-note" : undefined} />{nameError ? <p id="workflow-name-error" className="sr-only">{nameError}</p> : null}{editing ? <p id="workflow-name-note" className="builder-field-note">Workflow names stay fixed across revisions.</p> : null}</div>
        </Surface>

        <Surface padded={false}>
          <SectionHeader title="Trigger" description="When should it run?" />
          <fieldset className="builder-section builder-options" aria-invalid={Boolean(eventError)} aria-describedby={eventError ? "workflow-event-error" : undefined}><legend className="sr-only">Issue events</legend>
            <Choice checked={values.opened} onChange={(checked) => update("opened", checked)} title="Issue opened" />
            <Choice checked={values.reopened} onChange={(checked) => update("reopened", checked)} title="Issue reopened" />
            {eventError ? <p id="workflow-event-error" className="sr-only">{eventError}</p> : null}
          </fieldset>
        </Surface>

        <Surface padded={false}>
          <SectionHeader title="Repositories" description="Where can it run?" />
          <fieldset className="builder-section builder-options" aria-invalid={Boolean(repositoryError)} aria-describedby={repositoryError ? "workflow-repository-error" : undefined}><legend className="sr-only">Repositories</legend>
            {selectableRepositories.map((repository) => <Choice
              key={repository.id}
              checked={values.repositoryIds.includes(repository.id)}
              onChange={(checked) => toggleRepository(repository.id, checked)}
              title={`${repository.owner}/${repository.name}`}
              description={!isEnabled(repository.active) ? "Unavailable" : repository.paused ? "Paused" : undefined}
              icon={<GitBranchIcon size={16} aria-hidden="true" />}
            />)}
            {!selectableRepositories.length ? <p className="builder-empty">Connect a repository before creating a workflow.</p> : null}
            {repositoryError ? <p id="workflow-repository-error" className="sr-only">{repositoryError}</p> : null}
          </fieldset>
        </Surface>

        <Surface padded={false}>
          <SectionHeader title="Suggestions" description="What may it propose?" />
          <fieldset className="builder-section builder-options" aria-invalid={Boolean(outcomeError)} aria-describedby={outcomeError ? "workflow-outcome-error" : undefined}><legend className="sr-only">Workflow outcomes</legend>
            <Choice checked={values.suggestLabels} onChange={(checked) => updateOutcome("suggestLabels", checked)} title="Suggest labels" icon={<TagIcon size={16} aria-hidden="true" />} />
            <Choice checked={values.suggestReply} onChange={(checked) => updateOutcome("suggestReply", checked)} title="Suggest a reply" icon={<ChatCircleTextIcon size={16} aria-hidden="true" />} />
            {outcomeError ? <p id="workflow-outcome-error" className="sr-only">{outcomeError}</p> : null}
            <p className="builder-boundary-note"><ShieldCheckIcon size={16} aria-hidden="true" />These are hard limits.</p>
          </fieldset>
        </Surface>

        <Surface padded={false}>
          <SectionHeader
            title="Behavior"
            actions={<StatusBadge tone={customInstructions ? "info" : "neutral"}>{customInstructions ? "Custom" : "Guided"}</StatusBadge>}
          />
          <details className="agent-instructions-disclosure" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
            <summary>Advanced instructions</summary>
            <div className="builder-section agent-instructions">
              <div className="agent-instructions__heading"><label htmlFor="workflow-instructions">System instructions</label><Button type="button" variant="secondary" size="sm" icon={SparkleIcon} onClick={() => update("instructions", defaultWorkflowInstructions(values))}>Reset to guided</Button></div>
            <textarea
              ref={promptRef}
              id="workflow-instructions"
              className="agent-instructions__editor"
              value={values.instructions}
              onChange={(event) => update("instructions", event.target.value)}
              rows={8}
              maxLength={50_000}
              spellCheck="true"
              aria-invalid={Boolean(promptError)}
              aria-describedby={`workflow-instructions-help workflow-instructions-trust${promptError ? " workflow-instructions-error" : ""}`}
            />
            {promptError ? <p id="workflow-instructions-error" className="sr-only">{promptError}</p> : null}
            <p id="workflow-instructions-help" className="agent-instructions__help">Customize priorities and tone. Abilities and policies stay enforced.</p>
            <div className="prompt-variables">
              <div><strong>Insert trusted metadata</strong></div>
              <div className="prompt-variables__list">{systemPromptVariables.map((variable) => <button key={variable.id} type="button" className="prompt-variable" title={variable.description} aria-label={`Insert ${variable.label.toLowerCase()} variable`} onClick={() => insertPromptVariable(variable.id)}><span>{variable.label}</span><code>{`{{${variable.id}}}`}</code></button>)}</div>
            </div>
            <details className="prompt-example"><summary>Preview injected instructions</summary><pre>{instructionExample}</pre></details>
            <p id="workflow-instructions-trust" className="builder-context-note builder-context-note--compact"><ShieldCheckIcon size={16} aria-hidden="true" /><span>Only signed metadata is inserted. Issue content remains untrusted.</span></p>
              <div className="agent-instructions__meta"><span>{values.instructions.length.toLocaleString()} / 50,000 characters</span><span>Workers AI · deployment model</span></div>
            </div>
          </details>
        </Surface>

        <Surface padded={false}>
          <SectionHeader title="Approval" description="Who reviews its suggestions?" />
          <fieldset className="builder-section builder-options"><legend className="sr-only">Authority control</legend>
            <label className={`builder-choice${spec.capabilities.maximumMode === "approval" ? " builder-choice--selected" : ""}`}>
              <input type="radio" name="maximum-mode" checked={values.maximumMode === "approval"} onChange={() => update("maximumMode", "approval")} />
              <span className="builder-choice__radio" aria-hidden="true" />
              <span className="builder-choice__copy"><span><strong>Always require approval</strong><small>Gardener creates proposals for a person to review.</small></span></span>
            </label>
            <label className={`builder-choice${spec.capabilities.maximumMode === "instance_policy" ? " builder-choice--selected" : ""}`}>
              <input type="radio" name="maximum-mode" checked={values.maximumMode === "instance_policy"} onChange={() => update("maximumMode", "instance_policy")} />
              <span className="builder-choice__radio" aria-hidden="true" />
              <span className="builder-choice__copy"><span><strong>Follow instance policy</strong><small>Use Automatic only where the instance policy allows it.</small></span></span>
            </label>
            <div className="builder-inline-policies"><strong>Effective policy</strong>{values.suggestLabels ? <span>Labels <StatusBadge tone="info">{modeLabel(effectiveMode("issue.label.add"))}</StatusBadge></span> : null}{values.suggestReply ? <span>Replies <StatusBadge tone="info">{modeLabel(effectiveMode("issue.comment.create"))}</StatusBadge></span> : null}</div>
          </fieldset>
        </Surface>
      </div>

      <aside className="workflow-builder__summary" aria-label="Workflow summary">
        <Surface>
          <div className="agent-preview__header"><span className="agent-icon"><RobotIcon size={19} weight="duotone" aria-hidden="true" /></span><span><h2>Agent preview</h2><p>{values.name.trim() || "Untitled agent"}</p></span><StatusBadge tone="warning">Draft</StatusBadge></div>
          <dl className="builder-summary-list">
            <div><dt>When</dt><dd>{[values.opened ? "opened" : null, values.reopened ? "reopened" : null].filter(Boolean).join(" or ") || "No trigger"}</dd></div>
            <div><dt>Where</dt><dd>{values.repositoryIds.length ? `${values.repositoryIds.length} ${values.repositoryIds.length === 1 ? "repository" : "repositories"}` : "No repositories"}</dd></div>
            <div><dt>Suggests</dt><dd>{[values.suggestLabels ? "labels" : null, values.suggestReply ? "replies" : null].filter(Boolean).join(" and ") || "Nothing"}</dd></div>
            <div><dt>Policy</dt><dd>{spec.capabilities.maximumMode === "approval" ? "Approval required" : "Instance policy"}</dd></div>
          </dl>
          <p className="agent-preview__mode"><BracketsCurlyIcon size={14} aria-hidden="true" />{customInstructions ? "Custom behavior" : "Guided behavior"}</p>
          {diagnostics.length ? <div className="inline-error" role="alert">{diagnostics.map((message) => <p key={message}>{message}</p>)}</div> : null}
          {submissionError ? <p id="workflow-form-status" className="builder-form-hint" role="status" aria-live="polite">{submissionError}</p> : null}
          <Button type="submit" variant="primary" loading={saveMutation.isPending} disabled={Boolean(submissionError)} aria-describedby={submissionError ? "workflow-form-status" : undefined} className="builder-submit">{editing ? "Save new draft" : "Create draft"}</Button>
          <p className="builder-footnote">{editing ? "The current revision stays unchanged until you activate the new draft." : "Creating a draft does not activate or enable it."}</p>
        </Surface>
      </aside>
    </div>
  </form>;
}
