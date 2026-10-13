import { PageContainer } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function JobHistoryLoading() {
  return (
    <PageContainer aria-busy="true">
      <div role="status" aria-label="Loading history" className="flex flex-col gap-3">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-3 w-80 max-w-full" />
      </div>
      <div className="rounded-lg border border-border bg-surface p-6">
        <div className="flex flex-col gap-5">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="grid grid-cols-[4.5rem_2rem_minmax(0,1fr)] items-start gap-x-3">
              <Skeleton className="h-3 w-12 justify-self-end" />
              <Skeleton circle className="size-7" />
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3" style={{ maxWidth: `${50 + ((i * 23) % 40)}%` }} />
                <Skeleton className="h-2.5 w-32" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </PageContainer>
  );
}
