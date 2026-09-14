import {
  CheckCircleIcon,
  FloppyDiskIcon,
  FlaskIcon,
  ShieldCheckIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useGardener } from "../../app-context";
import { gardenerApi } from "../../lib/api";
import { queryKeys, queryPrefixes } from "../../lib/query-keys";
import type { AgentValidation } from "../../lib/types";
import { useNotifications } from "../../providers/notifications";
import {
  Banner,
  Button,
  Code,
  ErrorState,
  Field,
  Grid,
  Mono,
  PageHeader,
  PageHeaderSkeleton,
  Panel,
  PanelHeader,
  Select,
  TableSkeleton,
  Textarea,
} from "../../primitives";
import { CapabilityReview } from "./components/capability-review";

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

export function AgentEditorPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const { state } = useGardener();
  const detail = useQuery({
    queryKey: queryKeys.agent(id),
    queryFn: () => gardenerApi.agent(id!),
    enabled: editing,
  });
  const [source, setSource] = useState(starter);
  const [validation, setValidation] = useState<AgentValidation | null>(null);
  const [simulation, setSimulation] = useState<string | null>(null);
  const repositories = (state?.repositories ?? []).filter((repository) =>
    Boolean(repository.active),
  );
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
  const storedRepositoryId =
    detail.data?.draft?.thisRepositoryId ?? detail.data?.thisRepositoryId;
  const initialRepositoryId = storedRepositoryId ?? repositories[0]?.id ?? "";
  const dirty =
    !editing || source !== (storedSource ?? "") || thisRepositoryId !== initialRepositoryId;
  const validationErrors = useMemo(
    () => validation?.diagnostics.filter((item) => item.severity !== "warning") ?? [],
    [validation],
  );

  const resetReview = () => {
    setValidation(null);
    setSimulation(null);
  };
  const validate = useMutation({
    mutationFn: () => gardenerApi.validateAgent(source, id, thisRepositoryId || undefined),
    onSuccess: setValidation,
    onError: (error: Error) =>
      notify({ tone: "error", title: "Validation failed", description: error.message }),
  });
  const simulate = useMutation({
    mutationFn: () => gardenerApi.simulateAgent(source, id, thisRepositoryId || undefined),
    onSuccess: (result) => setSimulation(result.summary || result.status),
    onError: (error: Error) =>
      notify({ tone: "error", title: "Simulation failed", description: error.message }),
  });
  const save = useMutation({
    mutationFn: async () =>
      editing
        ? gardenerApi
            .saveAgentDraft(id!, source, thisRepositoryId || undefined)
            .then(() => id!)
        : gardenerApi
            .createAgent(source, thisRepositoryId || undefined)
            .then(({ agent }) => agent.id),
    onSuccess: async (agentId) => {
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.agents });
      notify({
        tone: "success",
        title: "Draft saved",
        description: "Saving a draft does not grant runtime authority.",
      });
      navigate(`/agents/${encodeURIComponent(agentId)}/draft`, { replace: true });
    },
    onError: (error: Error) =>
      notify({ tone: "error", title: "Draft was not saved", description: error.message }),
  });
  const publish = useMutation({
    mutationFn: async () => {
      let agentId = id;
      if (!agentId) {
        agentId = (await gardenerApi.createAgent(source, thisRepositoryId || undefined)).agent.id;
      }
      const result = await gardenerApi.publishAgent(
        agentId,
        source,
        thisRepositoryId || undefined,
      );
      return { agentId, revision: result.revision };
    },
    onSuccess: async ({ agentId, revision }) => {
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.agents });
      notify({
        tone: "success",
        title: `Revision ${revision} published paused`,
        description: "Activate it separately, then enable the Agent when you are ready.",
      });
      navigate(`/agents/${encodeURIComponent(agentId)}`);
    },
    onError: (error: Error) =>
      notify({
        tone: "error",
        title: "Revision was not published",
        description: error.message,
      }),
  });

  if (detail.isLoading) {
    return (
      <>
        <PageHeaderSkeleton />
        <Grid variant="2-1" gap="base" className="items-start [&>*]:min-w-0">
          <Panel padded={false}>
            <TableSkeleton rows={6} columns={1} />
          </Panel>
          <Panel padded={false}>
            <TableSkeleton rows={4} columns={1} />
          </Panel>
        </Grid>
      </>
    );
  }
  if (detail.error) {
    return (
      <ErrorState
        message={(detail.error as Error).message}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={editing ? `Edit ${detail.data?.agent.name ?? "Agent"}` : "New Agent"}
        description={
          "Author portable behavior in AGENT.md, then validate capabilities and test safely " +
          "before publishing a paused immutable revision."
        }
        actions={
          <Button
            variant="secondary"
            onClick={() =>
              navigate(editing ? `/agents/${encodeURIComponent(id!)}` : "/agents")
            }
          >
            Cancel
          </Button>
        }
      />
      <Grid variant="2-1" gap="base" className="items-start [&>*]:min-w-0">
        <Panel padded={false}>
          <PanelHeader
            title="AGENT.md"
            description={
              "Instructions guide judgment; they cannot grant authority, secrets, network " +
              "access, or policy changes."
            }
          />
          <div className="grid gap-4 p-4">
            <Select
              id="agent-this-repository"
              label={
                <>
                  Repository context for <Code code="this" />
                </>
              }
              hideLabel={false}
              value={thisRepositoryId}
              onValueChange={(value) => {
                setThisRepositoryId(value ?? "");
                resetReview();
              }}
              disabled={!repositories.length}
            >
              {!repositories.length ? (
                <Select.Option value="">No active repositories</Select.Option>
              ) : (
                repositories.map((repository) => (
                  <Select.Option key={repository.id} value={repository.id}>
                    <span className="flex min-w-0 flex-wrap items-center gap-1">
                      <span className="break-words">{repository.owner}/{repository.name}</span>
                      <span aria-hidden="true">·</span>
                      <Mono className="break-all">{repository.id}</Mono>
                    </span>
                  </Select.Option>
                ))
              )}
            </Select>
            <Field label="Agent package source">
              <Textarea
                id="agent-source"
                value={source}
                spellCheck={false}
                onChange={(event) => {
                  setSource(event.target.value);
                  resetReview();
                }}
                aria-describedby="agent-source-help"
                className={
                  "min-h-[480px] w-full max-w-full resize-y bg-kumo-recessed p-3.5 font-mono " +
                  "text-sm leading-relaxed md:min-h-[600px]"
                }
              />
            </Field>
            <p id="agent-source-help" className="text-xs text-kumo-subtle">
              Unknown fields and capabilities fail closed. Repository <Code code="this" /> is
              resolved to an immutable repository ID when compiled.
            </p>
          </div>
        </Panel>
        <aside className="grid min-w-0 gap-4 md:sticky md:top-20" aria-label="Agent review">
          <Panel padded={false}>
            <PanelHeader
              title="Capability review"
              description="Omitted capabilities mean none."
            />
            <CapabilityReview
              {...(validation?.capabilities ? { review: validation.capabilities } : {})}
            />
          </Panel>
          <Panel>
            <div className="flex gap-2 max-sm:flex-col">
              <Button
                className="flex-1"
                variant="secondary"
                icon={ShieldCheckIcon}
                loading={validate.isPending}
                onClick={() => validate.mutate()}
              >
                Validate
              </Button>
              <Button
                className="flex-1"
                variant="secondary"
                icon={FlaskIcon}
                loading={simulate.isPending}
                onClick={() => simulate.mutate()}
              >
                Simulate safely
              </Button>
            </div>
            {validation ? (
              <div className="mt-3.5 rounded-md bg-kumo-recessed p-3 text-xs" role="status">
                <strong className="flex items-center gap-1.5 text-kumo-strong">
                  {validation.valid && !validationErrors.length ? (
                    <>
                      <CheckCircleIcon size={16} aria-hidden="true" /> Valid Agent source
                    </>
                  ) : (
                    `${validationErrors.length} validation ${
                      validationErrors.length === 1 ? "error" : "errors"
                    }`
                  )}
                </strong>
                {validation.diagnostics.length ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-kumo-danger">
                    {validation.diagnostics.map((item, index) => (
                      <li key={`${item.code}-${index}`}>
                        <Mono className="inline text-kumo-danger">{item.path || item.code}</Mono>{" "}
                        {item.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {simulation ? (
              <div className="mt-3">
                <Banner
                  variant="secondary"
                  title="Simulation result"
                  description={simulation}
                />
              </div>
            ) : null}
          </Panel>
          <Panel>
            <h2 className="text-base font-semibold text-kumo-strong">Publication boundary</h2>
            <p className="mt-2 text-sm leading-relaxed text-kumo-subtle">
              Publishing creates an immutable paused revision. It does not activate the revision or
              enable the Agent.
            </p>
            <div className="mt-4 flex gap-2 max-sm:flex-col">
              <Button
                className="flex-1"
                variant="secondary"
                icon={FloppyDiskIcon}
                loading={save.isPending}
                disabled={!dirty}
                onClick={() => save.mutate()}
              >
                Save draft
              </Button>
              <Button
                className="flex-1"
                variant="primary"
                icon={UploadSimpleIcon}
                loading={publish.isPending}
                disabled={!validation?.publishable}
                onClick={() => publish.mutate()}
              >
                Publish paused
              </Button>
            </div>
          </Panel>
        </aside>
      </Grid>
    </>
  );
}
