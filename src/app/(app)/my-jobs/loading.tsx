import { PageContainer } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageContainer aria-busy="true" aria-label="Loading my jobs">
      <Skeleton className="h-16 w-full rounded-lg" aria-hidden="true" />
      <div className="flex flex-col gap-3" aria-hidden="true">
        <Skeleton className="h-5 w-32" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
              <div className="flex gap-2">
                <Skeleton className="h-9 w-28" />
                <Skeleton className="h-9 w-32" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <Skeleton className="h-11 w-full rounded-lg" aria-hidden="true" />
    </PageContainer>
  );
}
