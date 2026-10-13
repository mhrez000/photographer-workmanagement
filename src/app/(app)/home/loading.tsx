import { PageContainer } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";

function ListSkeleton({ rows, title }: { rows: number; title: string }) {
  return (
    <div role="status" aria-label={title} className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <div className="px-5 pt-4 pb-3">
        <Skeleton className="h-4 w-36" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-t border-border px-5 py-3.5">
          <Skeleton circle className="size-7" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-8 w-24 rounded-sm" />
        </div>
      ))}
    </div>
  );
}

/** Mirrors Home: topline, Ready to check, Needs attention + Coming up, Your editors. */
export default function HomeLoading() {
  return (
    <PageContainer aria-busy="true">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-10 w-32 rounded-md" />
      </div>
      <ListSkeleton rows={3} title="Loading ready to check" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ListSkeleton rows={3} title="Loading needs attention" />
        <ListSkeleton rows={3} title="Loading coming up" />
      </div>
      <ListSkeleton rows={2} title="Loading your editors" />
    </PageContainer>
  );
}
