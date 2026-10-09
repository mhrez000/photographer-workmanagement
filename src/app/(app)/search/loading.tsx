import { PageContainer } from "@/components/shell/page-container";
import { Skeleton } from "@/components/ui/skeleton";

export default function SearchLoading() {
  return (
    <PageContainer width="narrow" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-2.5 w-16" />
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
        <Skeleton className="mt-2 h-10 w-full" />
      </div>
      {[4, 2, 3].map((rows, g) => (
        <div key={g} className="flex flex-col gap-2">
          <Skeleton className="h-3 w-20" />
          <div className="rounded-lg border border-border bg-surface">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <Skeleton className="h-3.5 w-14" />
                <Skeleton className="h-3.5 flex-1" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </PageContainer>
  );
}
