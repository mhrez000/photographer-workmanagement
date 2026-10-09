import { PageContainer } from "@/components/shell";
import { Skeleton, SkeletonCards } from "@/components/ui/skeleton";

/** Mirrors Team Work: header, four stat tiles, filter bar, person groups. */
export default function TeamWorkLoading() {
  return (
    <PageContainer aria-busy="true">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-8 w-52 rounded-md" />
      </div>
      <SkeletonCards count={4} columns={4} className="grid-cols-2" />
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-72 max-w-full rounded-md" />
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="hidden h-8 w-24 rounded-full sm:block" />
        ))}
      </div>
      <div className="flex flex-col gap-3" role="status" aria-label="Loading team work">
        {Array.from({ length: 4 }, (_, g) => (
          <div key={g} className="overflow-hidden rounded-lg border border-border bg-surface">
            <div className="flex items-center gap-3 px-4 py-3">
              <Skeleton circle className="size-8" />
              <Skeleton className="h-4 w-36" />
              <Skeleton className="ml-auto h-6 w-48 rounded-full" />
            </div>
            <div className="flex flex-col divide-y divide-border border-t border-border">
              {Array.from({ length: 3 }, (_, r) => (
                <div key={r} className="flex items-center gap-6 px-4 py-3">
                  <Skeleton className="h-3.5 w-56" />
                  <Skeleton className="hidden h-3 w-24 md:block" />
                  <Skeleton className="hidden h-5 w-20 rounded-full md:block" />
                  <Skeleton className="ml-auto h-5 w-14 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
