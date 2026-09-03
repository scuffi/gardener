import { Banner } from "@cloudflare/kumo/components/banner";
import { ArrowRightIcon, CheckCircleIcon, CheckSquareIcon, GitBranchIcon, ListChecksIcon, PauseCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useGardener } from "../app-context";
import { isEnabled } from "../lib/format";
import type { Run } from "../lib/types";
import { RunDetailDialog, RunTable } from "../components/run-table";
import { AutomationTrace, Metric, PageHeader, SectionHeader, StatusBadge, Surface } from "../components/ui";

export function OverviewPage() {
  const { state, health } = useGardener();
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  if (!state) return null;
  const repositories = state.repositories.filter((repository) => isEnabled(repository.active)).length;
  const workflows = state.workflows.filter((workflow) => isEnabled(workflow.enabled)).length;
  const failures = state.runs.filter((run) => ["failed", "completed_with_errors"].includes(run.status)).length;
  const approvals = state.approvals.length;

  return <div id="operating-dashboard">
    <PageHeader
      title="Overview"
      description="Monitor repository automation, review pending actions, and verify your Cloudflare deployment."
    />

    {state.globalPaused ? <Banner
      variant="alert"
      icon={<PauseCircleIcon size={20} weight="fill" />}
      title="Automation is paused"
      description="New runs and GitHub writes are stopped. Received events and audit records remain available."
    /> : !health?.ok ? <Banner
      variant="error"
      icon={<WarningCircleIcon size={20} weight="fill" />}
      title="Deployment needs attention"
      description="One or more required Cloudflare services are unavailable. Review Deployment health in Settings before relying on automation."
      action={<Link to="/settings">Review deployment health</Link>}
    /> : <div className="runtime-status">
      <div className="runtime-status__signal"><span aria-hidden="true" /><CheckCircleIcon size={21} weight="fill" aria-hidden="true" /></div>
      <div className="runtime-status__copy"><div><strong>Automation is active across your repositories</strong><StatusBadge tone="success">Live</StatusBadge></div><p>Listening for opened and reopened issue events across {repositories} connected {repositories === 1 ? "repository" : "repositories"}.</p></div>
      <AutomationTrace />
    </div>}

    <div className="metric-grid">
      <Metric icon={CheckSquareIcon} label="Pending approvals" value={approvals} detail={approvals ? "Action required" : "Nothing waiting"} tone={approvals ? "warning" : "default"} />
      <Metric icon={WarningCircleIcon} label="Failed runs" value={failures} detail="Last 50 runs" tone={failures ? "danger" : "default"} />
      <Metric icon={GitBranchIcon} label="Connected repositories" value={repositories} detail="GitHub access active" tone="success" />
      <Metric icon={ListChecksIcon} label="Enabled workflows" value={workflows} detail="Listening for events" tone="info" />
    </div>

    {approvals > 0 ? <Surface className="attention-panel">
      <div><p className="overline">Action required</p><h2>{approvals} {approvals === 1 ? "operation is" : "operations are"} waiting for approval</h2><p>Review the proposed GitHub changes before they execute.</p></div>
      <Link className="text-link text-link--with-icon" to="/approvals">Review approvals <ArrowRightIcon size={16} /></Link>
    </Surface> : null}

    <Surface padded={false}>
      <SectionHeader
        title="Recent runs"
        description="The latest issue events processed by enabled workflows."
        actions={<Link className="text-link" to="/runs">View all runs</Link>}
      />
      <RunTable runs={state.runs.slice(0, 6)} onSelect={setSelectedRun} />
    </Surface>
    <RunDetailDialog run={selectedRun} onClose={() => setSelectedRun(null)} />
  </div>;
}
