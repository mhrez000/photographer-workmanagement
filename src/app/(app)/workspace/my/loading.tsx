import { PageContainer } from "@/components/shell";
import { MyWorkSkeleton } from "@/components/my-work";
import { Skeleton } from "@/components/ui/skeleton";

export default function MyWorkLoading() {
  return (
    <PageContainer>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-2.5 w-36" />
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-80 max-w-full" />
      </div>
      <MyWorkSkeleton />
    </PageContainer>
  );
}
