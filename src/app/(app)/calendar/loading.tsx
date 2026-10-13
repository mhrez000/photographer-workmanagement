import { PageContainer } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the Calendar page: header, month toolbar, 6-week grid. */
export default function CalendarLoading() {
  return (
    <PageContainer aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-8 rounded-sm" />
        <Skeleton className="h-8 w-8 rounded-sm" />
        <Skeleton className="h-6 w-40" />
      </div>
      <div role="status" aria-label="Loading calendar" className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border">
        {Array.from({ length: 42 }, (_, i) => (
          <div key={i} className="flex min-h-20 flex-col gap-1 bg-surface p-1.5 sm:min-h-28">
            <Skeleton className="size-6 rounded-full" />
            {i % 3 === 0 ? <Skeleton className="h-5 w-full rounded-sm" /> : null}
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
