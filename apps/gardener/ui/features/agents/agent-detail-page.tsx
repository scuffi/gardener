import { PencilSimpleIcon, PlayIcon, PowerIcon, RobotIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { gardenerApi } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { queryKeys, queryPrefixes } from "../../lib/query-keys";
import { useNotifications } from "../../providers/notifications";
import {
  Banner,
  Button,
  CodeBlock,
  EmptyState,
  ErrorState,
  Mono,
  PageHeader,
  PageHeaderSkeleton,
  Panel,
  PanelHeader,
  shortHash,
  StatusBadge,
  TableSkeleton,
} from "../../primitives";

export function AgentDetailPage() {
  const { id, revision: revisionParam } = useParams();
  const navigate = useNavigate();
  const revisionNumber = revisionParam ? Number(revisionParam) : null;
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
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
    mutationFn: (number: number) => gardenerApi.activateAgentRevision(id!, number),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.agent });
      notify({
        tone: "success",
        title: "Revision activated",
        description: "The Agent remains disabled until enabled separately.",
      });
    },
    onError: (error: Error) =>
      notify({
        tone: "error",
        title: "Revision was not activated",
        description: error.message,
      }),
  });
  const enable = useMutation({
    mutationFn: (enabled: boolean) => gardenerApi.setAgentEnabled(id!, enabled),
    onSuccess: async ({ enabled }) => {
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.agent });
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.agents });
      notify({ tone: "success", title: enabled ? "Agent enabled" : "Agent disabled" });
    },
    onError: (error: Error) =>
      notify({
        tone: "error",
        title: "Agent status was not changed",
        description: error.message,
      }),
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
      <ErrorState
        message={(detail.error as Error)?.message ?? "Agent was not found."}
        onRetry={() => void detail.refetch()}
      />
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
              variant="secondary"
              icon={PencilSimpleIcon}
              onClick={() => navigate(`/agents/${encodeURIComponent(agent.id)}/draft`)}
            >
              {draft ? "Edit draft" : "Create draft"}
            </Button>
            {!revisionNumber ? (
              <Button
                variant={agent.enabled ? "secondary" : "primary"}
                icon={PowerIcon}
                loading={enable.isPending}
                disabled={!agent.activeRevision}
                onClick={() => enable.mutate(!agent.enabled)}
              >
                {agent.enabled ? "Disable Agent" : "Enable Agent"}
              </Button>
            ) : null}
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
                <dt className="text-xs font-semibold text-kumo-subtle">Runtime</dt>
                <dd className="mt-1">
                  <StatusBadge tone={agent.enabled ? "success" : "neutral"}>
                    {agent.enabled ? "Enabled" : "Disabled"}
                  </StatusBadge>
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
              selected && !selected.active ? (
                <Button
                  variant="primary"
                  icon={PlayIcon}
                  loading={activate.isPending}
                  onClick={() => activate.mutate(revisionNumber)}
                >
                  Activate revision
                </Button>
              ) : selected?.active ? (
                <StatusBadge tone="success">Active</StatusBadge>
              ) : null
            }
          />
          {revision.isLoading ? (
            <TableSkeleton rows={6} columns={1} />
          ) : revision.error ? (
            <div className="p-4">
              <ErrorState message={(revision.error as Error).message} />
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
              "Publishing creates immutable paused history. Activation and enablement are " +
              "separate owner actions."
            }
          />
          {revisions.length ? (
            <div>
              {revisions.map((item) => (
                <article
                  key={item.id}
                  className={
                    "grid min-h-16 grid-cols-[minmax(0,1fr)_auto_90px] items-center gap-4 " +
                    "border-b border-kumo-hairline px-4 py-3 last:border-b-0 max-sm:grid-cols-1"
                  }
                >
                  <div className="grid min-w-0 gap-0.5">
                    <strong className="flex items-center gap-1 text-sm text-kumo-strong">
                      Revision <Mono tone="strong">{String(item.revision)}</Mono>
                    </strong>
                    <span className="text-xs text-kumo-subtle">
                      Published {formatRelativeTime(item.publishedAt)}
                      {item.publishedBy ? ` by ${item.publishedBy}` : ""}
                    </span>
                  </div>
                  <Mono title={item.sourceHash}>{shortHash(item.sourceHash)}</Mono>
                  <div className="justify-self-end max-sm:justify-self-start">
                    {item.active ? (
                      <StatusBadge tone="success">Active</StatusBadge>
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
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              title="No immutable revision has been published. The Agent cannot run."
              description=""
            />
          )}
        </Panel>
      )}
    </>
  );
}
