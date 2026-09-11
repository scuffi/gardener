import type { ReactNode } from "react";
import { sentenceCase } from "../../../lib/format";
import type { RunTask } from "../../../lib/types";
import { Mono, Panel, PanelHeader, RunStatus } from "../../../primitives";
import { formatDuration } from "../format-run";

export function TaskGraph({ tasks }: { tasks: RunTask[] }) {
  const orderedTasks = [...tasks].sort((left, right) => left.created_at.localeCompare(right.created_at));
  const taskIds = new Set(orderedTasks.map((task) => task.id));
  const children = new Map<string | null, RunTask[]>();

  for (const task of orderedTasks) {
    const parentId = task.parent_task_id && taskIds.has(task.parent_task_id) ? task.parent_task_id : null;
    children.set(parentId, [...(children.get(parentId) ?? []), task]);
  }

  const renderLevel = (levelTasks: RunTask[]): ReactNode => {
    const groups = new Map<string, RunTask[]>();
    for (const task of levelTasks) {
      const key = task.parallel_group ? `parallel:${task.parallel_group}` : `task:${task.id}`;
      groups.set(key, [...(groups.get(key) ?? []), task]);
    }

    return [...groups.entries()].map(([groupKey, groupTasks]) => {
      const parallelGroup = groupTasks[0]?.parallel_group;
      const taskNodes = groupTasks.map((task) => (
        <div key={task.id} className="min-w-0">
          <article className="min-w-0 rounded-md border border-kumo-hairline bg-kumo-base p-3">
            <div className="flex min-w-0 items-start justify-between gap-3 max-sm:flex-col">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Mono tone="strong">{task.stable_key}</Mono>
                  <RunStatus status={task.status} />
                </div>
                <p className="mt-1 text-sm text-kumo-default">{sentenceCase(task.kind)}</p>
              </div>
              <div className="flex-none text-right text-xs text-kumo-subtle max-sm:text-left">
                <span>{formatDuration(task.started_at, task.completed_at)}</span>
                <Mono title={task.id}>{task.id.slice(0, 12)}</Mono>
              </div>
            </div>
          </article>
          {(children.get(task.id)?.length ?? 0) > 0 ? (
            <div className="ml-5 border-l border-kumo-hairline py-2 pl-3 max-sm:ml-2">
              {renderLevel(children.get(task.id) ?? [])}
            </div>
          ) : null}
        </div>
      ));

      return parallelGroup ? (
        <section
          key={groupKey}
          className="mb-2 min-w-0 rounded-md border border-dashed border-kumo-line bg-kumo-recessed p-2"
        >
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1 text-xs text-kumo-subtle">
            <span className="font-semibold uppercase tracking-wide">Parallel</span>
            <Mono>{parallelGroup}</Mono>
            <span>{groupTasks.length} concurrent tasks</span>
          </div>
          <div className="grid min-w-0 gap-2">{taskNodes}</div>
        </section>
      ) : (
        <div key={groupKey} className="mb-2 min-w-0">
          {taskNodes}
        </div>
      );
    });
  };

  return (
    <Panel padded={false}>
      <PanelHeader
        title="Task graph"
        description="Indented branches show parentage; outlined groups identify concurrent work."
      />
      <div className="min-w-0 p-3">{renderLevel(children.get(null) ?? [])}</div>
    </Panel>
  );
}
