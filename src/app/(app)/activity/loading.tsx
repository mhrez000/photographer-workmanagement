import { ActivityFeedSkeleton } from "@/components/activity/activity-skeleton";
import { PageContainer } from "@/components/shell/page-container";
import { Skeleton } from "@/components/ui/skeleton";

export default function ActivityLoading() {
  return (
    <PageContainer aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-2.5 w-24" />
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <div className="mt-2 flex flex-wrap gap-2">
          {[24, 20, 40, 28].map((w, i) => (
            <Skeleton key={i} className="h-8" style={{ width: `${w * 4}px` }} />
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-surface px-4 py-2 sm:px-5">
        <ActivityFeedSkeleton />
      </div>
    </PageContainer>
  );
}
