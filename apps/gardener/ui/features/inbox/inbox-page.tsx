import { CheckIcon, TrayIcon, XIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gardenerApi } from "../../lib/api";
import { formatRelativeTime, sentenceCase } from "../../lib/format";
import { queryKeys, queryPrefixes } from "../../lib/query-keys";
import type { InboxItem } from "../../lib/types";
import { useNotifications } from "../../providers/notifications";
import {
  Button,
  CardSkeleton,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  StatusBadge,
  type StatusTone,
} from "../../primitives";

function priorityTone(item: InboxItem): StatusTone {
  if (item.priority === "urgent") return "danger";
  if (item.priority === "high") return "warning";
  return "neutral";
}

export function InboxPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const query = useQuery({ queryKey: queryKeys.inbox, queryFn: gardenerApi.inbox });
  const mutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "reject" | "dismiss" }) =>
      gardenerApi.respondToInbox(id, action),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.inbox });
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
        <div className="grid gap-2.5">
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
                    <p className="mt-0.5 text-xs text-kumo-subtle">
                      {sentenceCase(item.kind)} · {formatRelativeTime(item.createdAt)}
                    </p>
                  </div>
                  <StatusBadge tone={priorityTone(item)}>{sentenceCase(item.priority)}</StatusBadge>
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
                      Reject
                    </Button>
                  ) : null}
                  {(item.actions ?? []).includes("approve") ? (
                    <Button
                      variant="primary"
                      icon={CheckIcon}
                      disabled={mutation.isPending}
                      onClick={() => mutation.mutate({ id: item.id, action: "approve" })}
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
        />
      )}
    </>
  );
}
