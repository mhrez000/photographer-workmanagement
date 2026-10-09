import { PageContainer } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the calendar: header, toolbar, legend, month grid (agenda list on phones). */
export default function CalendarLoading() {
  return (
    <PageContainer aria-busy="true" aria-label="Loading the calendar">
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <div className="flex flex-col gap-3 lg:flex-row lg:justify-between">
        <div className="flex items-center gap-2">
          <Skeleton className="size-8" />
          <Skeleton className="size-8" />
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-6 w-36" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-36" />
        </div>
      </div>
      <div className="hidden overflow-hidden rounded-lg border border-border md:block">
        <div className="grid grid-cols-7 border-b border-border">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="flex justify-center p-2">
              <Skeleton className="h-3 w-8" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {Array.from({ length: 35 }, (_, i) => (
            <div key={i} className="min-h-28 space-y-1.5 border-b border-r border-border p-1.5 lg:min-h-32">
              <Skeleton circle className="size-6" />
              {i % 3 === 0 ? <Skeleton className="h-5 w-full" /> : null}
              {i % 4 === 1 ? <Skeleton className="h-5 w-4/5" /> : null}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4 md:hidden">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-20 w-full rounded-md" />
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
