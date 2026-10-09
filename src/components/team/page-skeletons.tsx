import * as React from "react";
import { PageContainer } from "@/components/shell/page-container";
import { Skeleton, SkeletonCards, SkeletonTable } from "@/components/ui/skeleton";
import { range } from "@/lib/utils";

/** Header block matching PageHeader (eyebrow, title, description, actions). */
export function HeaderSkeleton({ actions = 1 }: { actions?: number }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="flex gap-2">
        {range(actions).map((i) => (
          <Skeleton key={i} className="h-9 w-28" />
        ))}
      </div>
    </div>
  );
}

export function TilesSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden="true">
      {range(count).map((i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3.5 py-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5" aria-hidden="true">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3 w-64 max-w-full" />
      <Skeleton className="w-full" style={{ height }} />
    </div>
  );
}

/** Directory pages: header, tiles, search row, person cards. */
export function DirectorySkeleton() {
  return (
    <PageContainer aria-busy="true">
      <HeaderSkeleton />
      <TilesSkeleton />
      <Skeleton className="h-9 w-72 max-w-full" />
      <SkeletonCards count={6} columns={3} />
    </PageContainer>
  );
}

/** Table-led pages (workloads, performance, reports). */
export function TablePageSkeleton({ tiles = 4, rows = 8, columns = 7, controls = true }: { tiles?: number; rows?: number; columns?: number; controls?: boolean }) {
  return (
    <PageContainer aria-busy="true">
      <HeaderSkeleton actions={2} />
      {tiles > 0 ? <TilesSkeleton count={tiles} /> : null}
      {controls ? <Skeleton className="h-9 w-80 max-w-full" /> : null}
      <SkeletonTable rows={rows} columns={columns} />
    </PageContainer>
  );
}

/** Chart-led pages (analytics, person detail). */
export function ChartsPageSkeleton({ tiles = 8, charts = 4 }: { tiles?: number; charts?: number }) {
  return (
    <PageContainer aria-busy="true">
      <HeaderSkeleton actions={1} />
      <TilesSkeleton count={tiles} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {range(charts).map((i) => (
          <ChartSkeleton key={i} />
        ))}
      </div>
    </PageContainer>
  );
}
