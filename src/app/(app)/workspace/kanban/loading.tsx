import { PageContainer } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the board: header, filter row, seven columns of cards. */
export default function KanbanLoading() {
  return (
    <PageContainer width="full" className="max-w-[2200px]" aria-busy="true" aria-label="Loading the board">
      <div className="flex flex-col gap-4">
        <div className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-full max-w-lg" />
        </div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-full" />
          ))}
        </div>
      </div>
      <div className="-mx-4 flex gap-3 overflow-hidden px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        {Array.from({ length: 7 }, (_, c) => (
          <div key={c} className="flex w-[86vw] max-w-80 shrink-0 flex-col gap-2 rounded-lg border border-border bg-surface-sunken/70 p-3 sm:w-72">
            <div className="mb-1 flex items-center justify-between">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-8 rounded-full" />
            </div>
            {Array.from({ length: 4 - (c % 3) }, (_, i) => (
              <div key={i} className="space-y-2 rounded-md border border-border bg-surface p-3">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-3 w-2/3" />
                <div className="flex justify-between pt-1">
                  <Skeleton circle className="size-5" />
                  <Skeleton className="h-5 w-14 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
