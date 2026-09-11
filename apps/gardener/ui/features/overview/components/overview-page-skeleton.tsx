import { PageHeaderSkeleton, Panel, SkeletonLine, TableSkeleton } from "../../../primitives";

export function OverviewPageSkeleton() {
  return (
    <div aria-label="Loading overview" role="status">
      <PageHeaderSkeleton />
      <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
        {Array.from({ length: 4 }, (_, index) => (
          <Panel key={index} className="min-h-[104px]">
            <SkeletonLine className="h-4 w-1/2" />
            <SkeletonLine className="mt-4 h-7 w-1/3" />
            <SkeletonLine className="mt-2 h-3 w-2/3" />
          </Panel>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-4 max-lg:grid-cols-1">
        <Panel padded={false}>
          <TableSkeleton rows={6} columns={3} />
        </Panel>
        <Panel padded={false}>
          <TableSkeleton rows={4} columns={2} />
        </Panel>
      </div>
    </div>
  );
}
