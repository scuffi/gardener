import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { ArrowSquareOutIcon, CheckIcon, CheckSquareIcon, PauseCircleIcon, XIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import { formatDate, parseOperation } from "../lib/format";
import type { Approval } from "../lib/types";
import { operationMetadata } from "../lib/types";
import { ConfirmDialog } from "../components/confirm-dialog";
import { useNotifications } from "../components/notifications";
import { EmptyState, PageHeader, StatusBadge } from "../components/ui";

export function ApprovalsPage() {
  const { state } = useGardener();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { notify } = useNotifications();
  const [decision, setDecision] = useState<{ approval: Approval; action: "approve" | "reject" } | null>(null);
  const mutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "reject" }) => action === "approve" ? gardenerApi.approve(id) : gardenerApi.reject(id),
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["state"] });
      setDecision(null);
      notify({ tone: "success", title: variables.action === "approve" ? "Operation approved" : "Operation rejected", description: variables.action === "approve" ? "Connect revalidated access and recorded the execution result." : "The proposal will not execute." });
    },
    onError: (error: Error) => notify({ tone: "error", title: "Unable to record decision", description: error.message }),
  });
  if (!state) return null;

  return <>
    <PageHeader title="Approvals" description="Validate proposed GitHub changes before they execute. Every decision is recorded in the audit trail." />
    {state.globalPaused ? <Banner variant="alert" icon={<PauseCircleIcon size={20} weight="fill" />} title="Automation is paused" description="Resume automation before approving an operation. You can still reject pending proposals." /> : null}
    {state.approvals.length ? <div className="approval-list">{state.approvals.map((approval) => {
      const metadata = operationMetadata[approval.operation_kind] ?? { name: approval.operation_kind, description: "Proposed GitHub operation", risk: "medium" as const };
      const operation = parseOperation(approval.operation);
      const detail = String(operation.label ?? operation.body ?? operation.kind ?? "Review the structured operation below.");
      return <article className="approval-card" key={approval.id}>
        <header className="approval-card__header">
          <div><p className="overline">{approval.owner}/{approval.name}</p><h2>{metadata.name}</h2></div>
          <StatusBadge tone={metadata.risk === "high" ? "error" : metadata.risk === "medium" ? "warning" : "info"}>{metadata.risk} risk</StatusBadge>
        </header>
        <div className="approval-card__context">
          <span>Issue <code>{approval.resource_id}</code></span><span>Triggered by {approval.action.replaceAll("_", " ")}</span><span>{formatDate(approval.created_at)}</span>
        </div>
        <p className="approval-card__rationale">{approval.rationale}</p>
        <div className="operation-preview"><span>Proposed change</span><p>{detail}</p></div>
        <footer className="approval-card__footer">
          <Button variant="ghost" icon={ArrowSquareOutIcon} onClick={() => navigate(`/runs?selected=${encodeURIComponent(approval.run_id)}`)}>View originating run</Button>
          <div><Button variant="secondary-destructive" icon={XIcon} onClick={() => setDecision({ approval, action: "reject" })}>Reject</Button><Button variant="primary" icon={CheckIcon} disabled={state.globalPaused} onClick={() => setDecision({ approval, action: "approve" })}>Approve</Button></div>
        </footer>
      </article>;
    })}</div> : <div className="surface"><EmptyState icon={CheckSquareIcon} title="No operations need approval" description="Proposals that require a decision will appear here with their repository, rationale, and exact GitHub change." /></div>}

    <ConfirmDialog
      open={Boolean(decision)}
      onOpenChange={(open) => { if (!open) setDecision(null); }}
      title={decision?.action === "approve" ? "Approve this GitHub operation?" : "Reject this proposal?"}
      description={decision?.action === "approve"
        ? "Gardener Connect will revalidate repository access and current GitHub state immediately before executing the change."
        : "The proposed operation will be marked rejected and will not execute."}
      detail={decision ? <><strong>{operationMetadata[decision.approval.operation_kind]?.name ?? decision.approval.operation_kind}</strong><p>{decision.approval.owner}/{decision.approval.name}</p></> : null}
      confirmLabel={decision?.action === "approve" ? "Approve and execute" : "Reject proposal"}
      confirmTone={decision?.action === "approve" ? "primary" : "destructive"}
      loading={mutation.isPending}
      onConfirm={() => decision ? mutation.mutateAsync({ id: decision.approval.id, action: decision.action }) : undefined}
    />
  </>;
}
