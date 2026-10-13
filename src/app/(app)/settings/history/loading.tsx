import { ActivityFeedSkeleton } from "@/components/activity";
import { PageContainer } from "@/components/shell/page-container";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageContainer aria-busy="true" aria-label="Loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <ActivityFeedSkeleton />
    </PageContainer>
  );
}
