import { PageContainer } from "@/components/shell";
import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

/** Mirrors the All Work layout: header, saved views, filter bar, table. */
export default function AllWorkLoading() {
  return (
    <PageContainer aria-busy="true">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-28 rounded-md" />
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Skeleton className="h-7 w-24 rounded-full" />
          <Skeleton className="h-7 w-28 rounded-full" />
          <Skeleton className="h-7 w-20 rounded-full" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-72 max-w-full rounded-md" />
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="hidden h-8 w-24 rounded-full sm:block" />
          ))}
          <Skeleton className="ml-auto h-8 w-40 rounded-sm" />
        </div>
      </div>
      <SkeletonTable rows={12} columns={9} className="hidden md:block" />
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface md:hidden" role="status" aria-label="Loading jobs">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex justify-between gap-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
