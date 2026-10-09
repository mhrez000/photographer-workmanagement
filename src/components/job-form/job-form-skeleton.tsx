import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { range } from "@/lib/utils";

/** Loading placeholder for the job forms: header, then settings-style sections. */
export function JobFormSkeleton({ sections = 4, withPreview = false }: { sections?: number; withPreview?: boolean }) {
  return (
    <div role="status" aria-label="Loading form" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>
      <div className={withPreview ? "grid gap-8 xl:grid-cols-[minmax(0,1fr)_19rem]" : undefined}>
        <div className="flex flex-col">
          {range(sections).map((s) => (
            <div key={s} className="grid gap-x-10 gap-y-4 border-t border-border py-7 first:border-t-0 first:pt-0 lg:grid-cols-[15rem_minmax(0,1fr)]">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-52 max-w-full" />
              </div>
              <div className="flex flex-col gap-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  {range(2).map((f) => (
                    <div key={f} className="flex flex-col gap-1.5">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-9 w-full rounded-md" />
                    </div>
                  ))}
                </div>
                {s === 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-9 w-full rounded-md" />
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {withPreview ? (
          <div className="hidden xl:block">
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-3 w-32" />
              <div className="flex gap-1.5">
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="mt-2 h-24 w-full" />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
