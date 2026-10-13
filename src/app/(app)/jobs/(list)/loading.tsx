import { PageContainer } from "@/components/shell";
import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

/** Mirrors the Jobs page: header, stage tabs, filters, table / cards. */
export default function JobsLoading() {
  return (
    <PageContainer aria-busy="true">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
        <div className="flex gap-6 overflow-hidden border-b border-border pb-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-4 w-24 shrink-0" />
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-72 max-w-full rounded-md" />
        <Skeleton className="h-8 w-40 rounded-sm" />
        <Skeleton className="h-8 w-44 rounded-sm" />
      </div>
      <SkeletonTable rows={10} columns={6} className="hidden md:block" />
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface md:hidden" role="status" aria-label="Loading jobs">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 px-4 py-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <div className="flex gap-2">
              <Skeleton className="h-6 w-24 rounded-full" />
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
