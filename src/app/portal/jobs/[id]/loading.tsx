import { Skeleton } from "@/components/ui/skeleton";

/** /portal/jobs/[id] skeleton: header card with stepper, links, feedback. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading this job">
      <Skeleton className="h-4 w-40" />
      <div className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-6">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-12 w-full" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-32" />
    </div>
  );
}
