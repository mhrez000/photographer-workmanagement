import { PageContainer } from "@/components/shell";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";

/** Mirrors the single-scroll job page: header, next-step card, sections, details column. */
export default function JobDetailLoading() {
  return (
    <PageContainer className="gap-5" aria-busy="true">
      <div role="status" aria-label="Loading job" className="flex flex-col gap-3">
        <Skeleton className="h-3 w-24" />
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-7 w-80 max-w-full" />
          </div>
          <Skeleton className="size-9 rounded-md" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-7 w-32 rounded-full" />
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-6 w-24 rounded-full" />
        </div>
        <Skeleton className="h-3 w-44" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="hidden rounded-lg border border-border bg-surface p-5 lg:block">
            <Skeleton className="mb-2 h-2.5 w-16" />
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <Skeleton className="h-4 w-64" />
              <div className="flex gap-2">
                <Skeleton className="h-9 w-32 rounded-md" />
                <Skeleton className="h-9 w-28 rounded-md" />
              </div>
            </div>
          </div>
          {[3, 2, 4].map((rows, i) => (
            <div key={i} className="rounded-lg border border-border bg-surface p-5">
              <Skeleton className="mb-4 h-4 w-32" />
              <div className="flex flex-col gap-3">
                {Array.from({ length: rows }, (_, r) => (
                  <div key={r} className="flex items-center justify-between gap-4">
                    <SkeletonText lines={1} className="flex-1" />
                    <Skeleton className="h-8 w-20 rounded-sm" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-border bg-surface p-5">
          <Skeleton className="mb-4 h-4 w-20" />
          <div className="flex flex-col gap-3">
            {Array.from({ length: 6 }, (_, r) => (
              <div key={r} className="flex justify-between gap-4">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
