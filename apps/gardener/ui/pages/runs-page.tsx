import { Select } from "@cloudflare/kumo/components/select";
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
      title="Runs"
      description="Inspect every workflow execution, model result, proposed operation, failure, and recorded cost."
      actions={<div className="compact-field"><span>Status</span><Select aria-label="Filter runs by status" size="sm" className="run-filter" value={filter} onValueChange={(value) => setFilter(value ?? "all")} items={{ all: "All runs", completed: "Completed", queued: "Queued", failed: "Failed", completed_with_errors: "Completed with errors" }} /></div>}
    />
    <Surface padded={false}><RunTable runs={runs} onSelect={(run) => { setSelectedRun(run); setSearchParams({ selected: run.id }); }} /></Surface>
    <RunDetailDialog run={selectedRun} onClose={() => { setSelectedRun(null); setSearchParams({}); }} />
  </>;
}
