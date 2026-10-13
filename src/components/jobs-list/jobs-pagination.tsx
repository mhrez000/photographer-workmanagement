import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { jobsWord } from "./format";

export interface JobsPaginationProps {
  /** Rows on this page. */
  shown: number;
  /** 0-based offset of the first row on this page. */
  offset: number;
  total: number;
  prevHref: string | null;
  nextHref: string | null;
  className?: string;
}

/** "Showing 1–50 of 123" with Previous / Next links (offset cursors from the query). */
export function JobsPagination({ shown, offset, total, prevHref, nextHref, className }: JobsPaginationProps) {
  if (total === 0) return null;
  const from = offset + 1;
  const to = offset + shown;
  const linkClass = "inline-flex h-8 items-center gap-1 rounded-sm px-2.5 text-sm font-medium text-ink-secondary hover:bg-surface-muted hover:text-ink focus-ring";
  const disabledClass = "inline-flex h-8 items-center gap-1 rounded-sm px-2.5 text-sm font-medium text-ink-subtle";
  return (
    <nav aria-label="Pages" className={cn("flex items-center justify-between gap-3 text-sm text-ink-muted", className)}>
      <p className="numeric">
        {total > shown ? `Showing ${from}–${to} of ${jobsWord(total)}` : jobsWord(total)}
      </p>
      {prevHref || nextHref ? (
        <div className="flex items-center gap-1">
          {prevHref ? (
            <Link href={prevHref} className={linkClass}>
              <ChevronLeft aria-hidden="true" className="size-4" />
              Previous
            </Link>
          ) : (
            <span aria-disabled="true" className={disabledClass}>
              <ChevronLeft aria-hidden="true" className="size-4" />
              Previous
            </span>
          )}
          {nextHref ? (
            <Link href={nextHref} className={linkClass}>
              Next
              <ChevronRight aria-hidden="true" className="size-4" />
            </Link>
          ) : (
            <span aria-disabled="true" className={disabledClass}>
              Next
              <ChevronRight aria-hidden="true" className="size-4" />
            </span>
          )}
        </div>
      ) : null}
    </nav>
  );
}
