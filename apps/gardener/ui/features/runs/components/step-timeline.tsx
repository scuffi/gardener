import type { RunStep, RunTask } from "../../../lib/types";
import {
  EmptyState,
  Mono,
  Panel,
  PanelHeader,
  RunStatus,
  shortHash,
  StatusBadge,
} from "../../../primitives";
import { formatDuration } from "../format-run";

export function StepTimeline({ tasks, steps }: { tasks: RunTask[]; steps: RunStep[] }) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const orderedSteps = [...steps].sort((left, right) => left.created_at.localeCompare(right.created_at));
  const groupedSteps = new Map<string, RunStep[]>();

  for (const step of orderedSteps) {
    groupedSteps.set(step.task_id, [...(groupedSteps.get(step.task_id) ?? []), step]);
  }

  return (
    <Panel padded={false}>
      <PanelHeader
        title="Step timeline"
        description="Steps are ordered within their task. Additional attempts are called out as retries."
      />
      {!orderedSteps.length ? (
        <EmptyState
          compact
          title="No steps were recorded"
          description="Step attempts will appear here as the run executes task work."
        />
      ) : (
        <div className="divide-y divide-kumo-hairline">
          {[...groupedSteps.entries()].map(([taskId, taskSteps]) => {
            const task = taskById.get(taskId);
            return (
              <section key={taskId} className="min-w-0 p-4">
                <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-kumo-strong">Task</h3>
                  <Mono title={task?.stable_key ?? taskId} tone="strong">
                    {task?.stable_key ?? shortHash(taskId)}
                  </Mono>
                  <span className="text-xs text-kumo-subtle">{taskSteps.length} steps</span>
                </div>
                <ol className="ml-2 border-l border-kumo-hairline pl-4">
                  {taskSteps.map((step) => {
                    const retries = Math.max(0, step.attempt_count - 1);
                    return (
                      <li key={step.id} className="relative min-w-0 pb-4 last:pb-0">
                        <span
                          aria-hidden="true"
                          className={
                            "absolute top-2 -left-[21px] size-2 rounded-full border " +
                            "border-kumo-line bg-kumo-base"
                          }
                        />
                        <div className="flex min-w-0 items-start justify-between gap-3 max-sm:flex-col">
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <Mono tone="strong">{step.kind}</Mono>
                              <RunStatus status={step.status} />
                              {retries > 0 ? (
                                <StatusBadge tone="warning">
                                  {retries} {retries === 1 ? "retry" : "retries"}
                                </StatusBadge>
                              ) : null}
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                              <Mono title={step.stable_key}>{step.stable_key}</Mono>
                              <span className="text-xs text-kumo-subtle">
                                Attempt {step.attempt_count} of {step.max_attempts}
                              </span>
                            </div>
                          </div>
                          <span className="flex-none text-xs text-kumo-subtle">
                            {formatDuration(step.started_at, step.completed_at)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
