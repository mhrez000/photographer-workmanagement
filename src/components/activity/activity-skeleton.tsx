import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder rows matching ActivityFeed (day header + avatar + sentence + time). */
export function ActivityFeedSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col">
      <Skeleton className="my-2.5 h-3 w-20" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-3 border-b border-border/70 py-3 last:border-b-0">
          <Skeleton circle className="size-8 shrink-0" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-3.5" style={{ width: `${45 + ((i * 17) % 40)}%` }} />
            {i % 3 === 0 ? <Skeleton className="h-3 w-24" /> : null}
          </div>
          <Skeleton className="mt-1 h-3 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}
