import { Panel } from "./panel";
import { SkeletonLine } from "./kumo";

/**
 * Loading placeholders built on Kumo `SkeletonLine`.
 *
 * Prefer these over a spinner for content areas: they preserve layout, so the page does not jump
 * when data arrives. Kumo styles the shimmer for both schemes already.
 */

/** Title-and-description block matching `PageHeader`'s metrics. */
export function PageHeaderSkeleton() {
  return (
    <div className="mb-6" aria-hidden="true">
      <SkeletonLine className="h-8 w-64" />
      <SkeletonLine className="mt-3 h-4 w-full max-w-[560px]" />
    </div>
  );
}

/** Rows for a table-shaped surface. */
export function TableSkeleton({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div role="status" aria-live="polite" aria-label="Loading">
      <div
        className={
          "border-b border-kumo-hairline bg-(--color-gardener-surface-strong) px-4 py-2.5"
        }
      >
        <SkeletonLine className="h-3 w-24" />
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="grid items-center gap-4 border-b border-kumo-hairline px-4 py-3.5 last:border-b-0"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }, (_, column) => (
            <SkeletonLine key={column} className={column === 0 ? "h-4 w-3/4" : "h-3 w-1/2"} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Card grid placeholder. */
export function CardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading"
      className="grid grid-cols-2 gap-3 max-md:grid-cols-1"
    >
      {Array.from({ length: count }, (_, index) => (
        <Panel key={index}>
          <SkeletonLine className="h-4 w-1/2" />
          <SkeletonLine className="mt-3 h-3 w-full" />
          <SkeletonLine className="mt-2 h-3 w-2/3" />
        </Panel>
      ))}
    </div>
  );
}
