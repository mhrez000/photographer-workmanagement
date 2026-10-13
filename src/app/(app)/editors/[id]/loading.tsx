import { PageContainer } from "@/components/shell";
import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageContainer aria-busy="true" aria-label="Loading editor">
      <div className="flex flex-wrap items-end justify-between gap-4" aria-hidden="true">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-56" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3.5 py-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-12" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2" aria-hidden="true">
        <div className="rounded-lg border border-border bg-surface p-5">
          <Skeleton className="mb-4 h-5 w-40" />
          <SkeletonTable rows={4} columns={3} header={false} />
        </div>
        <div className="rounded-lg border border-border bg-surface p-5">
          <Skeleton className="mb-4 h-5 w-40" />
          <SkeletonTable rows={4} columns={3} header={false} />
        </div>
      </div>
      <Skeleton className="h-64 w-full rounded-lg" aria-hidden="true" />
    </PageContainer>
  );
}
