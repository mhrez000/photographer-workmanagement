import { Skeleton } from "@/components/ui/skeleton";

/** /portal skeleton: heading + two project groups of job cards. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading your work">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      {[0, 1].map((g) => (
        <div key={g} className="flex flex-col gap-3">
          <Skeleton className="h-6 w-48" />
          <div className="grid gap-3 md:grid-cols-2">
            {[0, 1].map((c) => (
              <div key={c} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
                <div className="flex justify-between gap-3">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-6 w-20 rounded-full" />
                </div>
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-4 w-52" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
