import { Button } from "@cloudflare/kumo/components/button";
import { FlowArrowIcon, PlayIcon, StopIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import { formatRelativeTime, formatTrigger, isEnabled } from "../lib/format";
import { useNotifications } from "../components/notifications";
import { AutomationTrace, EmptyState, PageHeader, StatusBadge, Surface } from "../components/ui";

export function WorkflowsPage() {
  const { state } = useGardener();
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const mutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => gardenerApi.setWorkflow(id, enabled),
    onSuccess: async ({ enabled }) => {
      await queryClient.invalidateQueries({ queryKey: ["state"] });
      notify({ tone: "success", title: enabled ? "Workflow enabled" : "Workflow disabled", description: enabled ? "New supported events can create runs." : "New events will not create runs for this workflow." });
    },
    onError: (error: Error) => notify({ tone: "error", title: "Unable to update workflow", description: error.message }),
  });
  if (!state) return null;

  return <>
    <PageHeader title="Workflows" description="Versioned instructions that turn repository events into bounded, policy-checked operation proposals." />
    <Surface padded={false}>
      {state.workflows.length ? <>
        <div className="mobile-data-list">{state.workflows.map((workflow) => {
          const enabled = isEnabled(workflow.enabled);
          const pending = mutation.isPending && mutation.variables?.id === workflow.id;
          return <article className="mobile-data-card" key={workflow.id}>
            <div className="mobile-data-card__title"><span className="cell-with-icon"><FlowArrowIcon size={17} aria-hidden="true" /><strong>{workflow.name}</strong></span><StatusBadge tone={enabled ? "success" : "neutral"}>{enabled ? "Enabled" : "Disabled"}</StatusBadge></div>
            <p>Proposes conventional labels and bounded issue comments.</p>
            <AutomationTrace variant="workflow" compact />
            <dl><div><dt>Trigger</dt><dd>{formatTrigger(workflow.trigger_kind)}</dd></div><div><dt>Version</dt><dd><code>v{workflow.version}</code></dd></div><div><dt>Updated</dt><dd>{formatRelativeTime(workflow.updated_at)}</dd></div></dl>
            <Button variant={enabled ? "secondary" : "primary"} size="sm" icon={enabled ? StopIcon : PlayIcon} loading={pending} onClick={() => mutation.mutate({ id: workflow.id, enabled: !enabled })}>{enabled ? "Disable workflow" : "Enable workflow"}</Button>
          </article>;
        })}</div>
        <div className="table-scroll desktop-data-table" tabIndex={0} aria-label="Workflows"><table className="data-table">
          <thead><tr><th>Workflow</th><th>Status</th><th>Trigger</th><th>Version</th><th>Updated</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{state.workflows.map((workflow) => {
            const enabled = isEnabled(workflow.enabled);
            const pending = mutation.isPending && mutation.variables?.id === workflow.id;
            return <tr key={workflow.id}>
              <td><span className="cell-with-icon"><FlowArrowIcon size={18} aria-hidden="true" /><span><strong>{workflow.name}</strong><AutomationTrace variant="workflow" compact /></span></span></td>
              <td><StatusBadge tone={enabled ? "success" : "neutral"}>{enabled ? "Enabled" : "Disabled"}</StatusBadge></td>
              <td>{formatTrigger(workflow.trigger_kind)}</td>
              <td><code>v{workflow.version}</code></td>
              <td>{formatRelativeTime(workflow.updated_at)}</td>
              <td className="table-action"><Button variant={enabled ? "secondary" : "primary"} size="sm" icon={enabled ? StopIcon : PlayIcon} loading={pending} onClick={() => mutation.mutate({ id: workflow.id, enabled: !enabled })}>{enabled ? "Disable" : "Enable"}</Button></td>
            </tr>;
          })}</tbody>
        </table></div>
      </> : <EmptyState icon={FlowArrowIcon} title="No workflows available" description="Workflow definitions will appear after the deployment database is initialized." />}
    </Surface>
  </>;
}
