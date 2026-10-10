import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6" aria-busy="true" aria-label="Loading notifications">
      <Skeleton className="h-8 w-48" />
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-border">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3 bg-surface px-4 py-3.5">
            <Skeleton circle className="size-9" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
