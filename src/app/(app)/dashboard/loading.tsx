import { PageContainer } from "@/components/shell";
import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

/** Mirrors the dashboard: header, 8 KPI cards, bottleneck strip, workload table, two widget cards. */
export default function DashboardLoading() {
  return (
    <PageContainer aria-busy="true">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-2.5 w-40" />
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-3.5 w-80 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </div>
      <div role="status" aria-label="Loading dashboard" className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:gap-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3.5">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-7 w-14" />
            <Skeleton className="h-2.5 w-28" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-border bg-surface">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton circle className="size-6" />
            <Skeleton className="h-3 flex-1" style={{ maxWidth: `${360 - i * 60}px` }} />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      <SkeletonTable rows={6} columns={8} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:gap-5">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
            <Skeleton className="h-4 w-32" />
            {Array.from({ length: 4 }, (_, r) => (
              <div key={r} className="flex items-center gap-3">
                <Skeleton className="h-3 flex-1" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
