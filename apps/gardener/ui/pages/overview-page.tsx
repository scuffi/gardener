import { ArrowRightIcon, CheckSquareIcon, GitBranchIcon, ListChecksIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useGardener } from "../app-context";
import { isEnabled } from "../lib/format";
import type { Run } from "../lib/types";
import { RunDetailDialog, RunTable } from "../components/run-table";
import { Metric, PageHeader, SectionHeader, Surface } from "../components/ui";

export function OverviewPage() {
  const { state } = useGardener();
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

    <div className="metric-grid">
      <Metric icon={CheckSquareIcon} label="Pending approvals" value={approvals} detail={approvals ? "Action required" : "Nothing waiting"} tone={approvals ? "warning" : "default"} />
      <Metric icon={WarningCircleIcon} label="Failed runs" value={failures} detail="Last 50 runs" tone={failures ? "danger" : "default"} />
      <Metric icon={GitBranchIcon} label="Connected repositories" value={repositories} detail="GitHub access active" tone="success" />
      <Metric icon={ListChecksIcon} label="Enabled workflows" value={workflows} detail="Listening for events" tone="info" />
    </div>

    {approvals > 0 ? <Surface className="attention-panel">
      <div><h2>{approvals} {approvals === 1 ? "operation is" : "operations are"} waiting for approval</h2><p>Review the proposed GitHub changes before they execute.</p></div>
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
