import { CheckIcon, RobotIcon, TrayIcon, XIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { gardenerApi } from "../../lib/api";
import { formatRelativeTime, sentenceCase } from "../../lib/format";
import { queryKeys, queryPrefixes } from "../../lib/query-keys";
import { useNotifications } from "../../providers/notifications";
import {
  Button,
  CardSkeleton,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LinkButton,
  Mono,
  PageHeader,
  Panel,
  StatusBadge,
  statusTone,
} from "../../primitives";

export function InboxPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const [pendingApproval, setPendingApproval] = useState<{
    id: string;
    title: string;
    summary: string;
  } | null>(null);
  const lastPendingApproval = useRef<typeof pendingApproval>(null);
  if (pendingApproval) lastPendingApproval.current = pendingApproval;
  const renderedPendingApproval = pendingApproval ?? lastPendingApproval.current;
  const query = useQuery({ queryKey: queryKeys.inbox, queryFn: gardenerApi.inbox });
  const mutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "reject" | "dismiss" }) =>
      gardenerApi.respondToInbox(id, action),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.inbox });
      setPendingApproval(null);
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.state });
      notify({ tone: "success", title: "Inbox updated" });
    },
    onError: (error: Error) =>
      notify({
        tone: "error",
        title: "Decision was not recorded",
        description: error.message,
      }),
  });
  const items = query.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Inbox"
        description={
          "Review durable decisions, blocked work, failures, and regressions. Text from " +
          "repositories or models never grants authority."
        }
      />
      {query.isLoading ? (
        <CardSkeleton count={3} />
      ) : query.error ? (
        <ErrorState
          message={(query.error as Error).message}
          onRetry={() => void query.refetch()}
        />
      ) : items.length ? (
        <div className="grid gap-4">
          {items.map((item) => (
            <Panel
              key={item.id}
              as="article"
              className="grid grid-cols-[38px_minmax(0,1fr)] gap-3 max-sm:grid-cols-1"
            >
              <div
                aria-hidden="true"
                className="grid size-9 place-items-center rounded-md bg-kumo-warning/10 text-kumo-warning"
              >
                <TrayIcon size={18} />
              </div>
              <div className="min-w-0">
                <div className="flex items-start justify-between gap-4 max-sm:flex-col">
                  <div>
                    <h2 className="text-[15px] font-semibold text-kumo-strong">{item.title}</h2>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-kumo-subtle">
                      <Mono>{item.kind}</Mono>
                      <span aria-hidden="true">·</span>
                      <span>{formatRelativeTime(item.createdAt)}</span>
                    </p>
                  </div>
                  <StatusBadge tone={statusTone(item.priority)}>
                    {sentenceCase(item.priority)}
                  </StatusBadge>
                </div>
                <p className="mt-2.5 text-sm leading-relaxed text-kumo-default">
                  {item.summary || "This item needs your attention."}
                </p>
                <div className="mt-3.5 flex flex-wrap gap-2 max-sm:[&>button]:flex-1">
                  {(item.actions ?? ["dismiss"]).includes("reject") ? (
                    <Button
                      variant="secondary"
                      icon={XIcon}
                      disabled={mutation.isPending}
                      onClick={() => mutation.mutate({ id: item.id, action: "reject" })}
                    >
                      Reject exact request
                    </Button>
                  ) : null}
                  {(item.actions ?? []).includes("approve") ? (
                    <Button
                      variant="primary"
                      icon={CheckIcon}
                      disabled={mutation.isPending}
                      onClick={() =>
                        setPendingApproval({
                          id: item.id,
                          title: item.title,
                          summary: item.summary,
                        })
                      }
                    >
                      Approve exact request
                    </Button>
                  ) : null}
                  {(item.actions ?? ["dismiss"]).includes("dismiss") ? (
                    <Button
                      variant="secondary"
                      disabled={mutation.isPending}
                      onClick={() => mutation.mutate({ id: item.id, action: "dismiss" })}
                    >
                      Dismiss
                    </Button>
                  ) : null}
                </div>
              </div>
            </Panel>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={TrayIcon}
          title="Inbox clear"
          description="Interruptions, failed runs, pending effects, and regressions will appear here."
          action={
            <LinkButton href="/agents" variant="secondary" icon={RobotIcon}>
              View Agents
            </LinkButton>
          }
        />
      )}
      <ConfirmDialog
        open={Boolean(pendingApproval)}
        onOpenChange={(open) => {
          if (!open) setPendingApproval(null);
        }}
        title="Approve this exact request?"
        description={
          renderedPendingApproval
            ? `${renderedPendingApproval.title}. ${renderedPendingApproval.summary}`
            : "Review the bounded request before approving it."
        }
        confirmLabel="Approve exact request"
        loading={mutation.isPending}
        onConfirm={() =>
          pendingApproval
            ? mutation.mutateAsync({ id: pendingApproval.id, action: "approve" })
            : undefined
        }
      />
    </>
  );
}
