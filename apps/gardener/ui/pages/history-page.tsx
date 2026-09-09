import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { gardenerApi } from "../lib/api";
import { formatRelativeTime, sentenceCase } from "../lib/format";
import { EmptyState, ErrorState, LoadingState, PageHeader, RunStatus, Surface } from "../components/ui";

export function HistoryPage() {
  const query = useQuery({ queryKey: ["history"], queryFn: gardenerApi.history });
  const items = query.data?.items ?? [];
  return <>
    <PageHeader title="History" description="Inspect Agent runs, decisions, revision changes, and administrative actions. Receipts and security audit records remain the authoritative proof." />
    {query.isLoading ? <LoadingState label="Loading history" /> : query.error ? <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} /> : items.length ? <Surface className="history-timeline"><ol>{items.map((item) => <li key={item.id}><span className="history-timeline__dot" aria-hidden="true" /><article><header><div><strong>{item.title}</strong><span>{sentenceCase(item.kind)} · {formatRelativeTime(item.createdAt)}</span></div>{item.status ? <RunStatus status={item.status} /> : null}</header>{item.summary ? <p>{item.summary}</p> : null}{item.actor ? <small>Actor: {item.actor}</small> : null}</article></li>)}</ol></Surface> : <EmptyState icon={ClockCounterClockwiseIcon} title="No history yet" description="Agent revisions, runs, durable decisions, and policy changes will appear here." />}
  </>;
}
