import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { FloppyDiskIcon, ShieldCheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import type { PolicyMode } from "../lib/types";
import { operationMetadata } from "../lib/types";
import { ConfirmDialog } from "../components/confirm-dialog";
import { useNotifications } from "../components/notifications";
import { PageHeader, StatusBadge, Surface } from "../components/ui";

const modeCopy: Record<PolicyMode, { label: string; description: string; tone: "neutral" | "warning" | "success" }> = {
  disabled: { label: "Off", description: "Gardener cannot execute this operation.", tone: "neutral" },
  approval: { label: "Require approval", description: "A person must approve every proposal.", tone: "warning" },
  automatic: { label: "Automatic", description: "Valid proposals may execute without review.", tone: "success" },
};

export function PoliciesPage() {
  const { state } = useGardener();
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const [draft, setDraft] = useState<Record<string, PolicyMode>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => {
    if (state) setDraft(Object.fromEntries(state.policies.map((policy) => [policy.operation_kind, policy.mode])));
  }, [state]);
  const changed = useMemo(() => state?.policies.filter((policy) => draft[policy.operation_kind] && draft[policy.operation_kind] !== policy.mode) ?? [], [draft, state]);
  const increasesAuthority = changed.some((policy) => draft[policy.operation_kind] === "automatic");
  const mutation = useMutation({
    mutationFn: () => gardenerApi.setPolicies(changed.map((policy) => ({ operation: policy.operation_kind, mode: draft[policy.operation_kind]! }))),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["state"] });
      setConfirmOpen(false);
      notify({ tone: "success", title: "Policies saved", description: "New runs will use the updated operation permissions." });
    },
    onError: (error: Error) => notify({ tone: "error", title: "Unable to save policies", description: error.message }),
  });
  if (!state) return null;

  const save = () => { if (increasesAuthority) setConfirmOpen(true); else mutation.mutate(); };
  const reset = () => setDraft(Object.fromEntries(state.policies.map((policy) => [policy.operation_kind, policy.mode])));

  return <>
    <PageHeader title="Policies" description="Control which GitHub actions are disabled, require human approval, or may execute automatically." />
    <Banner
      variant="secondary"
      icon={<ShieldCheckIcon size={20} weight="fill" />}
      title="Model output is never authorization"
      description="Gardener applies these policies to every proposal. Connect revalidates repository access and current GitHub state immediately before each write."
    />
    <Surface className="policy-list" padded={false}>
      {state.policies.map((policy) => {
        const metadata = operationMetadata[policy.operation_kind] ?? { name: policy.operation_kind, description: "Control this operation.", risk: "medium" as const };
        const value = draft[policy.operation_kind] ?? policy.mode;
        return <div className="policy-row" key={policy.operation_kind}>
          <div className="policy-row__copy"><div><h2>{metadata.name}</h2><StatusBadge tone={metadata.risk === "high" ? "error" : metadata.risk === "medium" ? "warning" : "info"}>{metadata.risk} risk</StatusBadge></div><p>{metadata.description}</p></div>
          <fieldset className="policy-control"><legend className="sr-only">Policy for {metadata.name}</legend><div className="policy-segmented">
            {(Object.keys(modeCopy) as PolicyMode[]).map((mode) => <label key={mode} className={`policy-segment policy-segment--${mode}${value === mode ? " policy-segment--selected" : ""}`}><input type="radio" name={`policy-${policy.operation_kind}`} value={mode} checked={value === mode} onChange={() => setDraft((current) => ({ ...current, [policy.operation_kind]: mode }))} /><span>{modeCopy[mode].label}</span></label>)}
          </div><small>{modeCopy[value].description}</small></fieldset>
        </div>;
      })}
    </Surface>
    {changed.length ? <div className="save-bar" role="region" aria-label="Unsaved policy changes">
      <div><strong>{changed.length} unsaved {changed.length === 1 ? "change" : "changes"}</strong><span>Changes apply to new runs after you save.</span></div>
      <div><Button variant="secondary" onClick={reset}>Discard</Button><Button variant="primary" icon={FloppyDiskIcon} loading={mutation.isPending} onClick={save}>Save policies</Button></div>
    </div> : null}
    <ConfirmDialog
      open={confirmOpen}
      onOpenChange={setConfirmOpen}
      title="Allow automatic GitHub actions?"
      description="At least one change allows Gardener to execute a valid proposal without human approval. Access and current GitHub state will still be checked before every write."
      detail={<div className="authority-list">{changed.filter((policy) => draft[policy.operation_kind] === "automatic").map((policy) => <span key={policy.operation_kind}><WarningCircleIcon size={16} />{operationMetadata[policy.operation_kind]?.name ?? policy.operation_kind}</span>)}</div>}
      confirmLabel="Allow and save"
      confirmTone="primary"
      loading={mutation.isPending}
      onConfirm={() => mutation.mutateAsync()}
    />
  </>;
}
