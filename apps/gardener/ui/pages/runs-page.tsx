import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useGardener } from "../app-context";
import type { Run } from "../lib/types";
import { RunDetailDialog, RunTable } from "../components/run-table";
import { PageHeader, Surface } from "../components/ui";

export function RunsPage() {
  const { state } = useGardener();
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [filter, setFilter] = useState("all");
  const [searchParams, setSearchParams] = useSearchParams();
  const runs = useMemo(() => state?.runs.filter((run) => filter === "all" || run.status === filter) ?? [], [state?.runs, filter]);
  useEffect(() => {
    const selectedId = searchParams.get("selected");
    if (selectedId && state) setSelectedRun(state.runs.find((run) => run.id === selectedId) ?? null);
  }, [searchParams, state]);
  if (!state) return null;

  return <>
    <PageHeader
      eyebrow="Execution history"
      title="Runs"
      description="Inspect every workflow execution, model result, proposed operation, failure, and recorded cost."
      actions={<label className="compact-field"><span>Status</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All runs</option><option value="completed">Completed</option><option value="queued">Queued</option><option value="failed">Failed</option><option value="completed_with_errors">Completed with errors</option></select></label>}
    />
    <Surface padded={false}><RunTable runs={runs} onSelect={(run) => { setSelectedRun(run); setSearchParams({ selected: run.id }); }} /></Surface>
    <RunDetailDialog run={selectedRun} onClose={() => { setSelectedRun(null); setSearchParams({}); }} />
  </>;
}
