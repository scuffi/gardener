import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { ArrowSquareOutIcon, ClockIcon, CpuIcon, ReceiptIcon, XIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { gardenerApi } from "../lib/api";
import { formatCost, formatDate, formatRelativeTime, parseOperation, parseUsage, tokenCount } from "../lib/format";
import type { Run } from "../lib/types";
import { EmptyState, LoadingState, RunStatus } from "./ui";

export function RunTable({ runs, onSelect }: { runs: Run[]; onSelect: (run: Run) => void }) {
  if (!runs.length) return <EmptyState
    icon={ReceiptIcon}
    title="No issue events received"
    description="Open or reopen an issue in a connected repository to create the first run."
    compact
  />;
  return <>
    <div className="run-mobile-list">
      {runs.map((run) => {
        const usage = parseUsage(run.usage);
        const tokens = tokenCount(usage);
        return <button key={run.id} className="run-mobile-card" onClick={() => onSelect(run)}>
          <span className="run-mobile-card__top"><RunStatus status={run.status} /><span>{formatRelativeTime(run.created_at)}</span></span>
          <strong>{run.workflow_name}</strong>
          <span className="repo-name">{run.owner}/{run.name}</span>
          <span className="run-mobile-card__meta">{run.action.replaceAll("_", " ")}{tokens ? ` · ${tokens.toLocaleString()} tokens · ${formatCost(usage?.costUsd)}` : ""}</span>
        </button>;
      })}
    </div>
    <div className="table-scroll run-desktop-table" tabIndex={0} aria-label="Automation runs">
    <table className="data-table">
      <thead><tr><th>Status</th><th>Run</th><th>Repository</th><th>Started</th><th>Usage</th><th><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{runs.map((run) => {
        const usage = parseUsage(run.usage);
        const tokens = tokenCount(usage);
        return <tr key={run.id}>
          <td><RunStatus status={run.status} /></td>
          <td><button className="table-primary-link" onClick={() => onSelect(run)}>{run.workflow_name}</button><span className="table-secondary">{run.action.replaceAll("_", " ")}</span></td>
          <td><span className="repo-name">{run.owner}/{run.name}</span></td>
          <td><span title={formatDate(run.created_at)}>{formatRelativeTime(run.created_at)}</span></td>
          <td>{tokens ? <><span>{tokens.toLocaleString()} tokens</span><span className="table-secondary">{formatCost(usage?.costUsd)}</span></> : "—"}</td>
          <td className="table-action"><Button variant="ghost" shape="square" size="sm" aria-label={`View run ${run.id}`} icon={ArrowSquareOutIcon} onClick={() => onSelect(run)} /></td>
        </tr>;
      })}</tbody>
    </table>
  </div>
  </>;
}

export function RunDetailDialog({ run, onClose }: { run: Run | null; onClose: () => void }) {
  const detailQuery = useQuery({ queryKey: ["run", run?.id], queryFn: () => gardenerApi.run(run!.id), enabled: Boolean(run) });
  const usage = run ? parseUsage(run.usage) : null;
  return <Dialog.Root open={Boolean(run)} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog size="xl" className="run-dialog">
      <div className="dialog-header">
        <div><Dialog.Title>{run?.workflow_name ?? "Run details"}</Dialog.Title><Dialog.Description>{run ? `${run.owner}/${run.name} · ${formatDate(run.created_at)}` : ""}</Dialog.Description></div>
        <Dialog.Close render={<Button variant="ghost" shape="square" aria-label="Close run details" icon={XIcon} />} />
      </div>
      {run ? <div className="run-detail-summary">
        <div><span>Status</span><RunStatus status={run.status} /></div>
        <div><span>Trigger</span><strong>{run.action.replaceAll("_", " ")}</strong></div>
        <div><span>Model</span><strong>{usage?.model ?? "Workers AI"}</strong></div>
        <div><span>Usage</span><strong>{tokenCount(usage).toLocaleString()} tokens · {formatCost(usage?.costUsd)}</strong></div>
      </div> : null}
      {detailQuery.isLoading ? <LoadingState label="Loading run details" /> : null}
      {detailQuery.error ? <div className="inline-error" role="alert">{detailQuery.error.message}</div> : null}
      {run?.summary ? <section className="detail-section"><h3>Result</h3><p>{run.summary}</p>{run.error ? <pre className="error-detail">{run.error}</pre> : null}</section> : null}
      {detailQuery.data ? <>
        <section className="detail-section"><h3>Execution</h3><dl className="definition-grid">
          <div><dt>Attempts</dt><dd>{String(detailQuery.data.run.attempt_count ?? "—")}</dd></div>
          <div><dt>Started</dt><dd>{formatDate(detailQuery.data.run.started_at as string | undefined)}</dd></div>
          <div><dt>Completed</dt><dd>{formatDate(detailQuery.data.run.completed_at as string | undefined)}</dd></div>
          <div><dt>Workflow ID</dt><dd><code>{String(detailQuery.data.run.workflow_id ?? "—")}</code></dd></div>
        </dl></section>
        <section className="detail-section"><h3>Proposed operations</h3>
          {detailQuery.data.proposals.length ? <div className="proposal-list">{detailQuery.data.proposals.map((proposal) => {
            const operation = parseOperation(proposal.operation);
            return <article key={proposal.id} className="proposal-item">
              <div className="proposal-item__header"><strong>{proposal.operation_kind}</strong><RunStatus status={proposal.status} /></div>
              <p>{proposal.rationale}</p>
              <pre>{JSON.stringify(operation, null, 2)}</pre>
              {proposal.receipt ? <div className="receipt"><ReceiptIcon size={16} aria-hidden="true" /><span>Execution receipt recorded</span></div> : null}
              {proposal.error ? <div className="inline-error">{proposal.error}</div> : null}
            </article>;
          })}</div> : <p className="muted-copy">This run did not propose a GitHub operation.</p>}
        </section>
        <section className="detail-section detail-section--meta"><span><ClockIcon size={16} /> Durable run record</span><span><CpuIcon size={16} /> Executed with bounded Workers AI</span></section>
      </> : null}
    </Dialog>
  </Dialog.Root>;
}
