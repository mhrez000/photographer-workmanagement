import { PageContainer } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the notification centre: header, tabs, two day groups of rows. */
export default function NotificationsLoading() {
  return (
    <PageContainer width="narrow" aria-busy="true">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-3.5 w-64" />
          </div>
          <Skeleton className="h-9 w-32 rounded-md" />
        </div>
        <div className="flex gap-4 border-b border-border pb-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-10" />
        </div>
      </div>
      <div role="status" aria-label="Loading notifications" className="flex flex-col gap-6">
        {[4, 3].map((rows, g) => (
          <div key={g} className="flex flex-col gap-2">
            <Skeleton className="h-2.5 w-20" />
            <div className="overflow-hidden rounded-lg border border-border bg-surface">
              {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="flex items-start gap-3 border-b border-border px-5 py-3 last:border-0">
                  <Skeleton circle className="size-8" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-3.5 w-3/5" />
                    <Skeleton className="h-3 w-4/5" />
                    <Skeleton className="h-2.5 w-2/5" />
                  </div>
                  <Skeleton className="h-2.5 w-10" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
