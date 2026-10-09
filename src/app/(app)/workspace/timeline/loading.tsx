import { PageContainer } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";

const BARS: [number, number][] = [
  [8, 22],
  [14, 30],
  [2, 18],
  [30, 25],
  [20, 40],
  [45, 20],
  [10, 35],
  [55, 25],
];

/** Mirrors the Gantt: toolbar, legend, sticky label column and bar rows. */
export default function TimelineLoading() {
  return (
    <PageContainer width="full" className="max-w-[2000px]" aria-busy="true" aria-label="Loading the timeline">
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="flex flex-col gap-3 lg:flex-row lg:justify-between">
        <div className="flex items-center gap-2">
          <Skeleton className="size-8" />
          <Skeleton className="size-8" />
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-8 w-72" />
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex h-13 border-b border-border">
          <div className="w-36 shrink-0 border-r border-border sm:w-60" />
          <div className="flex-1" />
        </div>
        {BARS.map(([left, width], i) => (
          <div key={i} className="flex h-11 items-center border-b border-border/70 last:border-b-0">
            <div className="flex w-36 shrink-0 flex-col gap-1.5 border-r border-border px-3 sm:w-60">
              <Skeleton className="h-2.5 w-12" />
              <Skeleton className="h-3 w-4/5" />
            </div>
            <div className="relative h-full flex-1">
              <Skeleton className="absolute top-1/2 h-5 -translate-y-1/2 rounded-sm" style={{ left: `${left}%`, width: `${width}%` }} />
            </div>
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
