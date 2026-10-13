import { PageContainer } from "@/components/shell/page-container";
import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

function HeaderSkeleton({ actions = true }: { actions?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-2.5 w-32" />
        <Skeleton className="h-7 w-56 max-w-full" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {actions ? <Skeleton className="hidden h-9 w-28 sm:block" /> : null}
    </div>
  );
}

/** /clients and /projects list skeleton: header, toolbar, table (cards on mobile). */
export function ListPageSkeleton({ columns = 7 }: { columns?: number }) {
  return (
    <PageContainer aria-busy="true">
      <HeaderSkeleton />
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-8 w-full sm:w-72" />
        <Skeleton className="hidden h-5 w-32 sm:block" />
      </div>
      <div className="hidden rounded-lg border border-border bg-surface md:block">
        <SkeletonTable rows={8} columns={columns} />
      </div>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface md:hidden">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-8 rounded-md" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </PageContainer>
  );
}

/** Client / project detail skeleton: header, then the jobs list beside the side column. */
export function DetailPageSkeleton() {
  return (
    <PageContainer aria-busy="true">
      <HeaderSkeleton />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-border bg-surface">
          <SkeletonTable rows={6} columns={5} />
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex gap-3">
              <Skeleton circle className="size-7" />
              <Skeleton className="h-3.5 flex-1" />
            </div>
          ))}
        </div>
      </div>
    </PageContainer>
  );
}

/** Create-form skeleton. */
export function FormPageSkeleton({ fields = 5 }: { fields?: number }) {
  return (
    <PageContainer width="narrow" aria-busy="true">
      <HeaderSkeleton actions={false} />
      <div className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className={i === fields - 1 ? "h-20 w-full" : "h-9 w-full"} />
          </div>
        ))}
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
    </PageContainer>
  );
}
