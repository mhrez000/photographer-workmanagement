import { PageContainer } from "@/components/shell";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";

/** Mirrors the job detail layout: header, tab strip + panel, facts rail. */
export default function JobDetailLoading() {
  return (
    <PageContainer className="gap-0" aria-busy="true">
      <div role="status" aria-label="Loading job" className="flex flex-col gap-4 border-b border-border pb-4">
        <Skeleton className="h-3 w-56" />
        <div className="flex flex-wrap items-baseline gap-3">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-7 w-72 max-w-full" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-6 w-28 rounded-full" />
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex gap-5">
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton circle className="size-6" />
                <div className="flex flex-col gap-1">
                  <Skeleton className="h-2 w-16" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 w-32 rounded-md" />
            <Skeleton className="h-9 w-24 rounded-md" />
            <Skeleton className="h-9 w-9 rounded-md" />
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex gap-5 overflow-hidden border-b border-border pb-3">
            {[72, 52, 56, 80, 76, 68, 64, 60].map((w, i) => (
              <Skeleton key={i} className="h-4 shrink-0" style={{ width: w }} />
            ))}
          </div>
          <div className="rounded-lg border border-border bg-surface p-5">
            <Skeleton className="mb-4 h-4 w-32" />
            <div className="grid grid-cols-5 gap-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-1.5 rounded-full" />
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-surface p-5">
            <Skeleton className="mb-4 h-4 w-24" />
            <SkeletonText lines={4} />
          </div>
          <div className="rounded-lg border border-border bg-surface p-5">
            <Skeleton className="mb-4 h-4 w-20" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-4">
          {[8, 6, 5].map((rows, i) => (
            <div key={i} className="rounded-lg border border-border bg-surface p-5">
              <Skeleton className="mb-1 h-2.5 w-20" />
              <Skeleton className="mb-4 h-4 w-40" />
              <div className="flex flex-col gap-3">
                {Array.from({ length: rows }, (_, r) => (
                  <div key={r} className="grid grid-cols-[96px_1fr] gap-3">
                    <Skeleton className="h-3" />
                    <Skeleton className="h-3" style={{ maxWidth: `${60 + ((r * 29) % 40)}%` }} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </PageContainer>
  );
}
