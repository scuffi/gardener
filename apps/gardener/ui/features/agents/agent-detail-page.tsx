import { PencilSimpleIcon, PlayIcon, RobotIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useGardener } from "../../app-context";
import {
  gardenerApi,
  isOverlapConfirmationError,
} from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import type { AggregateOverlapWarning, AssignmentOverlapWarning } from "../../lib/types";
import { useNotifications } from "../../providers/notifications";
import {
  Banner,
  Button,
  CodeBlock,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LinkButton,
  Mono,
  PageHeader,
  PageHeaderSkeleton,
  Panel,
  PanelHeader,
  shortHash,
  StatusBadge,
  statusTone,
  Table,
  TableSkeleton,
} from "../../primitives";
import { AgentDeployments } from "./components/agent-deployments";

type ActivationWarning = AssignmentOverlapWarning | AggregateOverlapWarning;

export function AgentDetailPage() {
  const { id, revision: revisionParam } = useParams();
  const navigate = useNavigate();
  const revisionNumber = revisionParam ? Number(revisionParam) : null;
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const { session } = useGardener();
  const owner = session.authenticated && session.user.role === "owner";
  const [pendingRevision, setPendingRevision] = useState<number | null>(null);
  const pendingRevisionRef = useRef<number | null>(null);
  pendingRevisionRef.current = pendingRevision;
  const lastPendingRevision = useRef<number | null>(null);
  if (pendingRevision) lastPendingRevision.current = pendingRevision;
  const renderedPendingRevision = pendingRevision ?? lastPendingRevision.current;
  const [overlap, setOverlap] = useState<ActivationWarning | null>(null);
  const overlapRef = useRef<ActivationWarning | null>(null);
  overlapRef.current = overlap;
  const lastOverlap = useRef<ActivationWarning | null>(null);
  if (overlap) lastOverlap.current = overlap;
  const renderedOverlap = overlap ?? lastOverlap.current;
  const detail = useQuery({
    queryKey: queryKeys.agent(id),
    queryFn: () => gardenerApi.agent(id!),
    enabled: Boolean(id),
  });
  const revision = useQuery({
    queryKey: queryKeys.agentRevision(id, revisionNumber),
    queryFn: () => gardenerApi.agentRevision(id!, revisionNumber!),
    enabled: Boolean(id && revisionNumber),
  });
  const activate = useMutation({
    mutationFn: async ({
      number,
      warning,
    }: {
      number: number;
      warning?: ActivationWarning;
    }) => {
      const data = detail.data!;
      const currentRevisionId = data.revisions.find((item) => item.active)?.id ?? null;
      const assignmentSnapshot = await gardenerApi.agentAssignments(id!);
      try {
        const result = await gardenerApi.activateAgentRevisionWithPreconditions(
          id!,
          data.revisions.find((item) => item.revision === number)!.id,
          {
            expectedAssignmentEpoch:
              warning?.assignmentEpoch ?? assignmentSnapshot.assignmentEpoch,
            expectedCurrentRevisionId:
              warning && "currentActiveRevisionId" in warning
                ? warning.currentActiveRevisionId ?? currentRevisionId
                : currentRevisionId,
            reason: null,
            ...(warning ? { overlapFingerprint: warning.fingerprint } : {}),
          },
        );
        return {
          result,
          repositoryIds: assignmentSnapshot.assignments.map((item) => item.repositoryId),
        };
      } catch (error) {
        if (isOverlapConfirmationError(error)) {
          setPendingRevision(null);
          setOverlap(error.details!.warning);
          return null;
        }
        throw error;
      }
    },
    onSuccess: async (result) => {
      if (!result) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agent(id), exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agentAssignments(id), exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents, exact: true }),
        ...result.repositoryIds.map((repositoryId) =>
          queryClient.invalidateQueries({
            queryKey: queryKeys.repositoryAssignments(repositoryId),
            exact: true,
          }),
        ),
      ]);
      setPendingRevision(null);
      setOverlap(null);
      notify({
        tone: "success",
        title: "Revision activated",
        description: "Repository deployments keep their own enabled state and authority ceiling.",
      });
    },
    onError: (error: Error) => {
      setOverlap(null);
      notify({
        tone: "error",
        title: "Revision was not activated",
        description: error.message,
      });
    },
  });

  if (detail.isLoading) {
    return (
      <>
        <PageHeaderSkeleton />
        <Panel padded={false}>
          <TableSkeleton rows={4} columns={3} />
        </Panel>
      </>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <>
        <PageHeader
          title="Agent unavailable"
          description="Gardener could not load this Agent's current state and revision history."
        />
        <ErrorState
          message={(detail.error as Error)?.message ?? "Agent was not found."}
          onRetry={() => void detail.refetch()}
        />
      </>
    );
  }

  const { agent, revisions, draft } = detail.data;
  const selected = revisionNumber
    ? revisions.find((item) => item.revision === revisionNumber)
    : null;
  const pageTitle = revisionNumber
    ? `${agent.name} · revision ${revisionNumber}`
    : agent.name;

  return (
    <>
      <PageHeader
        title={pageTitle}
        description={agent.description || "Agent behavior and immutable revision history."}
        actions={
          <>
            <Button
              className="max-md:min-h-11 max-md:min-w-11"
              variant="secondary"
              icon={PencilSimpleIcon}
              onClick={() => navigate(`/agents/${encodeURIComponent(agent.id)}/draft`)}
            >
              {draft ? "Edit draft" : "Create draft"}
            </Button>

          </>
        }
      />
      <div className="mb-4 grid grid-cols-[minmax(280px,.7fr)_minmax(0,1.3fr)] gap-4 max-md:grid-cols-1">
        <Panel>
          <div className="grid grid-cols-[40px_minmax(0,1fr)] gap-3.5">
            <span className="grid size-10 place-items-center rounded-md bg-kumo-info/10 text-kumo-info">
              <RobotIcon size={22} aria-hidden="true" />
            </span>
            <dl className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
              <div className="min-w-0">
                <dt className="text-xs font-semibold text-kumo-subtle">Active revision</dt>
                <dd className="mt-1 text-sm font-semibold text-kumo-strong">
                  {agent.activeRevision ? <Mono>{String(agent.activeRevision)}</Mono> : "None"}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs font-semibold text-kumo-subtle">Deployments</dt>
                <dd className="mt-1 text-sm font-semibold text-kumo-strong">
                  Repository-scoped
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs font-semibold text-kumo-subtle">Draft</dt>
                <dd className="mt-1 text-sm font-semibold text-kumo-strong">
                  {draft ? "Unpublished changes" : "None"}
                </dd>
              </div>
            </dl>
          </div>
        </Panel>
        <Banner
          variant="secondary"
          title="Authority remains layered"
          description={
            "Instructions do not override compiled capabilities, instance policy, temporary " +
            "grants, exact-effect approval, or Connect live-state checks."
          }
        />
      </div>
      {!revisionNumber ? <AgentDeployments agent={agent} revisions={revisions} /> : null}
      {revisionNumber ? (
        <Panel padded={false}>
          <PanelHeader
            title={`Immutable revision ${revisionNumber}`}
            description={
              selected
                ? `Published ${formatRelativeTime(selected.publishedAt)}`
                : "Published Agent source"
            }
            actions={
              selected && !selected.active && owner ? (
                <Button
                  className="max-md:min-h-11 max-md:min-w-11"
                  variant="primary"
                  icon={PlayIcon}
                  loading={activate.isPending}
                  onClick={() => setPendingRevision(revisionNumber)}
                >
                  Activate revision
                </Button>
              ) : selected?.active ? (
                <StatusBadge tone={statusTone("active")}>Active</StatusBadge>
              ) : null
            }
          />
          {revision.isLoading ? (
            <TableSkeleton rows={6} columns={1} />
          ) : revision.error ? (
            <div className="p-4">
              <ErrorState
                message={(revision.error as Error).message}
                onRetry={() => void revision.refetch()}
              />
            </div>
          ) : (
            <div className="max-h-[680px] overflow-auto bg-kumo-recessed p-4 text-sm">
              <CodeBlock code={revision.data?.sourceMd ?? "Source is unavailable."} />
            </div>
          )}
        </Panel>
      ) : (
        <Panel padded={false}>
          <PanelHeader
            title="Revisions"
            description={
              "Publishing creates immutable paused history. Activation is an owner action; " +
              "runtime authority comes from repository deployments."
            }
          />
          {revisions.length ? (
            <>
            <div
              className="hidden min-w-0 overflow-x-auto md:block"
              data-testid="revision-desktop-table"
            >
              <Table className="min-w-[620px] text-sm">
                <Table.Header variant="compact">
                  <Table.Row>
                    <Table.Head>Revision</Table.Head>
                    <Table.Head>Published</Table.Head>
                    <Table.Head>Source hash</Table.Head>
                    <Table.Head sticky="right">
                      <span className="sr-only">Action</span>
                    </Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {revisions.map((item) => (
                    <Table.Row key={item.id}>
                      <Table.Cell>
                        <Mono tone="strong">{String(item.revision)}</Mono>
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap">
                        <span>{formatRelativeTime(item.publishedAt)}</span>
                        {item.publishedBy ? (
                          <>
                            <span aria-hidden="true"> · </span>
                            <Mono>{item.publishedBy}</Mono>
                          </>
                        ) : null}
                      </Table.Cell>
                      <Table.Cell>
                        <Mono title={item.sourceHash}>{shortHash(item.sourceHash)}</Mono>
                      </Table.Cell>
                      <Table.Cell sticky="right" className="text-right">
                        {item.active ? (
                          <StatusBadge tone={statusTone("active")}>Active</StatusBadge>
                        ) : (
                          <Button
                            variant="secondary"
                            onClick={() =>
                              navigate(
                                `/agents/${encodeURIComponent(agent.id)}/revisions/${item.revision}`,
                              )
                            }
                          >
                            Review
                          </Button>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
            <ol
              className="divide-y divide-kumo-hairline md:hidden"
              data-testid="revision-mobile-list"
            >
              {revisions.map((item) => (
                <li key={item.id} className="grid gap-4 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold text-kumo-subtle">Revision</p>
                      <p className="mt-1">
                        <Mono tone="strong">{String(item.revision)}</Mono>
                      </p>
                    </div>
                    {item.active ? (
                      <StatusBadge tone={statusTone("active")}>Active</StatusBadge>
                    ) : (
                      <Button
                        className="min-h-11 min-w-11"
                        variant="secondary"
                        onClick={() =>
                          navigate(
                            `/agents/${encodeURIComponent(agent.id)}/revisions/${item.revision}`,
                          )
                        }
                      >
                        Review
                      </Button>
                    )}
                  </div>
                  <dl className="grid gap-3">
                    <div>
                      <dt className="text-xs font-semibold text-kumo-subtle">Published</dt>
                      <dd className="mt-1 break-words text-sm text-kumo-default">
                        <span>{formatRelativeTime(item.publishedAt)}</span>
                        {item.publishedBy ? (
                          <>
                            <span aria-hidden="true"> · </span>
                            <Mono>{item.publishedBy}</Mono>
                          </>
                        ) : null}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-kumo-subtle">Source hash</dt>
                      <dd className="mt-1 text-sm">
                        <Mono title={item.sourceHash}>{shortHash(item.sourceHash)}</Mono>
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ol>
            </>
          ) : (
            <EmptyState
              compact
              title="No immutable revision has been published. The Agent cannot run."
              description="Publish the current draft to create immutable revision history."
              action={
                <LinkButton
                  className="max-md:min-h-11 max-md:min-w-11"
                  href={`/agents/${encodeURIComponent(agent.id)}/draft`}
                  variant="secondary"
                  icon={PencilSimpleIcon}
                >
                  Edit draft
                </LinkButton>
              }
            />
          )}
        </Panel>
      )}
      <ConfirmDialog
        open={pendingRevision !== null}
        onOpenChange={(open) => {
          if (!open) {
            pendingRevisionRef.current = null;
            setPendingRevision(null);
          }
        }}
        title={`Activate ${agent.name} revision ${renderedPendingRevision ?? ""}?`}
        description={
          `This changes the global behavior pointer for ${agent.name}. Enabled repository ` +
          "deployments will use the new revision for newly admitted runs."
        }
        confirmLabel={`Activate ${agent.name} revision ${renderedPendingRevision ?? ""}`}
        loading={activate.isPending}
        onConfirm={() => {
          const number = pendingRevisionRef.current;
          if (number === null) return;
          return activate.mutateAsync({ number });
        }}
      />
      <ConfirmDialog
        open={Boolean(overlap)}
        onOpenChange={(open) => {
          if (!open) {
            overlapRef.current = null;
            setOverlap(null);
          }
        }}
        title={`Confirm overlapping activation for ${agent.name}?`}
        description={
          "Multiple Agents may run independently for the same event and may each produce effects."
        }
        detail={renderedOverlap ? (
          <div className="grid gap-3 text-sm">
            {("repositories" in renderedOverlap
              ? renderedOverlap.repositories
              : [renderedOverlap]
            ).map((warning) => (
              <div key={warning.repositoryId}>
                <strong className="text-kumo-strong">
                  {warning.repositoryDisplayName ?? "Named repository"}
                </strong>
                {warning.conflicts.map((conflict) => (
                  <p key={conflict.assignmentId} className="mt-1 text-kumo-subtle">
                    {agent.name} overlaps {conflict.agentDisplayName ?? "another Agent"}.
                    {` Shared triggers: ${conflict.sharedTriggers.join(", ") || "none"}.`}
                    {` Shared effects: ${conflict.sharedEffects.join(", ") || "none"}.`}
                  </p>
                ))}
              </div>
            ))}
          </div>
        ) : null}
        confirmLabel={`Allow overlap and activate ${agent.name}`}
        loading={activate.isPending}
        onConfirm={() => {
          const warning = overlapRef.current;
          if (!warning || !renderedPendingRevision) return;
          return activate.mutateAsync({ number: renderedPendingRevision, warning });
        }}
      />
    </>
  );
}
