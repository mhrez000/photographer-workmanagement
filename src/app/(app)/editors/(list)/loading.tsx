import { PageContainer } from "@/components/shell";
import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageContainer aria-busy="true" aria-label="Loading editors">
      <div className="flex flex-wrap items-end justify-between gap-4" aria-hidden="true">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-9 w-36" />
        </div>
      </div>
      <Skeleton className="h-12 w-full rounded-lg" aria-hidden="true" />
      <div className="rounded-lg border border-border bg-surface p-5" aria-hidden="true">
        <Skeleton className="mb-4 h-5 w-32" />
        <SkeletonTable rows={4} columns={6} />
      </div>
    </PageContainer>
  );
}
