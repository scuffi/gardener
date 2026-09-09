import { Button } from "@cloudflare/kumo/components/button";
import { CheckIcon, TrayIcon, XIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gardenerApi } from "../lib/api";
import type { InboxItem } from "../lib/types";
import { formatRelativeTime, sentenceCase } from "../lib/format";
import { useNotifications } from "../components/notifications";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "../components/ui";

function tone(item: InboxItem) { return item.priority === "urgent" ? "error" as const : item.priority === "high" ? "warning" as const : "neutral" as const; }

export function InboxPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const query = useQuery({ queryKey: ["inbox"], queryFn: gardenerApi.inbox });
  const mutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "reject" | "dismiss" }) => gardenerApi.respondToInbox(id, action),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["inbox"] }); await queryClient.invalidateQueries({ queryKey: ["state"] }); notify({ tone: "success", title: "Inbox updated" }); },
    onError: (error: Error) => notify({ tone: "error", title: "Decision was not recorded", description: error.message }),
  });
  const items = query.data?.items ?? [];
  return <>
    <PageHeader title="Inbox" description="Review durable decisions, blocked work, failures, and regressions. Text from repositories or models never grants authority." />
    {query.isLoading ? <LoadingState label="Loading inbox" /> : query.error ? <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} /> : items.length ? <div className="inbox-list">
      {items.map((item) => <article className="inbox-card" key={item.id}>
        <div className="inbox-card__marker" aria-hidden="true"><TrayIcon size={18} /></div>
        <div className="inbox-card__body"><div className="inbox-card__heading"><div><h2>{item.title}</h2><p>{sentenceCase(item.kind)} · {formatRelativeTime(item.createdAt)}</p></div><StatusBadge tone={tone(item)}>{sentenceCase(item.priority)}</StatusBadge></div>
          <p className="inbox-card__summary">{item.summary || "This item needs your attention."}</p>
          <div className="inbox-card__actions">{(item.actions ?? ["dismiss"]).includes("reject") ? <Button variant="secondary" icon={XIcon} disabled={mutation.isPending} onClick={() => mutation.mutate({ id: item.id, action: "reject" })}>Reject</Button> : null}{(item.actions ?? []).includes("approve") ? <Button variant="primary" icon={CheckIcon} disabled={mutation.isPending} onClick={() => mutation.mutate({ id: item.id, action: "approve" })}>Approve exact request</Button> : null}{(item.actions ?? ["dismiss"]).includes("dismiss") ? <Button variant="secondary" disabled={mutation.isPending} onClick={() => mutation.mutate({ id: item.id, action: "dismiss" })}>Dismiss</Button> : null}</div>
        </div>
      </article>)}
    </div> : <EmptyState icon={TrayIcon} title="Inbox clear" description="Interruptions, failed runs, pending effects, and regressions will appear here." />}
  </>;
}
