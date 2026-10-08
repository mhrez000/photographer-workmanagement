import * as React from "react";
import { cn, range } from "@/lib/utils";

export interface SkeletonProps extends React.ComponentPropsWithRef<"div"> {
  /** Circular placeholder (avatars). */
  circle?: boolean;
}

/** Shimmering placeholder block. Size it with width/height classes. */
export function Skeleton({ className, circle, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("skeleton-shimmer", circle ? "rounded-full" : "rounded-sm", className)}
      {...props}
    />
  );
}

export interface SkeletonTextProps {
  lines?: number;
  className?: string;
}

/** A paragraph of placeholder lines with a shorter last line. */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden="true">
      {range(lines).map((i) => (
        <Skeleton key={i} className={cn("h-3", i === lines - 1 && lines > 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

export interface SkeletonTableProps {
  rows?: number;
  columns?: number;
  /** Render the header row. */
  header?: boolean;
  className?: string;
}

/** Placeholder for a data table while rows load. */
export function SkeletonTable({ rows = 6, columns = 5, header = true, className }: SkeletonTableProps) {
  return (
    <div
      role="status"
      aria-label="Loading table"
      className={cn("overflow-hidden rounded-lg border border-border bg-surface", className)}
    >
      {header ? (
        <div className="flex h-9 items-center gap-6 border-b border-border bg-surface-sunken px-4">
          {range(columns).map((c) => (
            <Skeleton key={c} className="h-2.5 flex-1" style={{ maxWidth: `${80 + ((c * 37) % 60)}px` }} />
          ))}
        </div>
      ) : null}
      {range(rows).map((r) => (
        <div
          key={r}
          className="flex h-10 items-center gap-6 border-b border-border px-4 last:border-0"
        >
          {range(columns).map((c) => (
            <Skeleton
              key={c}
              className="h-3 flex-1"
              style={{ maxWidth: `${60 + ((r * 53 + c * 31) % 120)}px` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export interface SkeletonCardsProps {
  count?: number;
  /** Grid columns at desktop. */
  columns?: 2 | 3 | 4;
  className?: string;
}

/** Placeholder for a KPI / card grid. */
export function SkeletonCards({ count = 4, columns = 4, className }: SkeletonCardsProps) {
  const grid = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-2 lg:grid-cols-3",
    4: "sm:grid-cols-2 xl:grid-cols-4",
  }[columns];

  return (
    <div role="status" aria-label="Loading" className={cn("grid grid-cols-1 gap-4", grid, className)}>
      {range(count).map((i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-2.5 w-32" />
        </div>
      ))}
    </div>
  );
}
