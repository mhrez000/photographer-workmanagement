import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type JobSectionTone = "danger" | "attention" | "default" | "muted";

export interface JobSectionProps {
  title: string;
  count: number;
  /** One short line under the title ("Do these first."). */
  hint?: string;
  tone?: JobSectionTone;
  /** Starts folded (native `<details>`, no JavaScript): Waiting to be checked, Done recently. */
  collapsed?: boolean;
  children: React.ReactNode;
}

const toneClasses: Record<JobSectionTone, { title: string; count: string }> = {
  danger: { title: "text-danger-fg", count: "bg-danger-soft text-danger-fg" },
  attention: { title: "text-attention-fg", count: "bg-attention-soft text-attention-fg" },
  default: { title: "text-ink", count: "bg-surface-muted text-ink-secondary" },
  muted: { title: "text-ink-secondary", count: "bg-surface-muted text-ink-muted" },
};

function Heading({ title, count, hint, tone }: Pick<JobSectionProps, "title" | "count" | "hint"> & { tone: JobSectionTone }) {
  const t = toneClasses[tone];
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <h2 className={cn("text-md font-semibold leading-6", t.title)}>{title}</h2>
      <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-2xs font-semibold numeric", t.count)}>{count}</span>
      {hint ? <p className="basis-full text-sm text-ink-muted">{hint}</p> : null}
    </div>
  );
}

/**
 * One section of My jobs (docs/SIMPLIFICATION-PLAN.md §6). Callers hide a section when it is empty; this
 * component only lays it out. Collapsed sections open with a tap and need no client code.
 */
export function JobSection({ title, count, hint, tone = "default", collapsed = false, children }: JobSectionProps) {
  if (collapsed) {
    return (
      <details className="group/section rounded-lg border border-border bg-surface shadow-xs">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:content-none focus-ring rounded-lg [&::-webkit-details-marker]:hidden">
          <Heading title={title} count={count} hint={hint} tone={tone} />
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-ink-subtle transition-transform group-open/section:rotate-180" />
        </summary>
        <div className="border-t border-border p-3 sm:p-4">{children}</div>
      </details>
    );
  }
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex items-center gap-3 px-0.5">
        <Heading title={title} count={count} hint={hint} tone={tone} />
      </div>
      {children}
    </section>
  );
}

/** Responsive grid for cards: one column on phones, two from `md`, three on wide laptops. */
export function CardGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <ul className={cn("grid gap-3 md:grid-cols-2 xl:grid-cols-3", className)}>{children}</ul>;
}
