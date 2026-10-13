import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { range } from "@/lib/utils";

/**
 * Loading placeholder for the job forms. The simple New job form is one column (plan §5): a title, eight
 * fields and the collapsed "More options" row. `withPreview` keeps the two-column edit-form layout.
 */
export function JobFormSkeleton({ sections = 8, withPreview = false }: { sections?: number; withPreview?: boolean }) {
  return (
    <div role="status" aria-label="Loading form" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-3.5 w-80 max-w-full" />
      </div>
      <div className={withPreview ? "grid gap-8 xl:grid-cols-[minmax(0,1fr)_19rem]" : "mx-auto w-full max-w-2xl"}>
        <div className="flex flex-col gap-5">
          {range(sections).map((f) => (
            <div key={f} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className={f === sections - 1 ? "h-20 w-full rounded-md" : "h-9 w-full rounded-md"} />
            </div>
          ))}
          <Skeleton className="h-11 w-full rounded-lg" />
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-32" />
          </div>
        </div>
        {withPreview ? (
          <div className="hidden xl:block">
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-3 w-32" />
              <Skeleton className="mt-2 h-24 w-full" />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
