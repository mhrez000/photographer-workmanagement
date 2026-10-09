import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { range } from "@/lib/utils";

/** Loading placeholder matching the My Work layout: summary strip, then two sections of cards. */
export function MyWorkSkeleton() {
  return (
    <div role="status" aria-label="Loading your queue" className="flex flex-col gap-6">
      <div className="flex gap-2 overflow-hidden sm:grid sm:grid-cols-4 lg:grid-cols-7">
        {range(7).map((i) => (
          <div key={i} className="flex min-w-[7.5rem] flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2.5">
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="h-6 w-8" />
          </div>
        ))}
      </div>
      {range(2).map((section) => (
        <div key={section} className="flex flex-col gap-3">
          <div className="flex items-center gap-3 py-1.5">
            <Skeleton circle className="size-7" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="hidden h-3 w-56 sm:block" />
          </div>
          {range(section === 0 ? 3 : 2).map((card) => (
            <div key={card} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 md:flex-row md:gap-6">
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-2.5 w-40" />
                <Skeleton className="h-4 w-64 max-w-full" />
                <div className="flex gap-1.5">
                  <Skeleton className="h-5 w-20 rounded-full" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                  <Skeleton className="h-5 w-14 rounded-full" />
                </div>
                <Skeleton className="h-3 w-48" />
              </div>
              <div className="flex gap-2 md:w-60 md:flex-col md:items-end">
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-8 w-24" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
