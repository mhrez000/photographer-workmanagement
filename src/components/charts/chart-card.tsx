import * as React from "react";
import { ChartNoAxesColumn } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { cn } from "@/lib/utils";

export interface ChartCardProps {
  title: React.ReactNode;
  /** One-line takeaway shown under the title — what the chart means, in words. */
  takeaway?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  /** Render the empty placeholder instead of the chart. */
  empty?: boolean;
  emptyMessage?: React.ReactNode;
  className?: string;
  id?: string;
  children?: React.ReactNode;
}

/** Card frame for a chart: title, takeaway sentence, body (or a quiet empty state). */
export function ChartCard({ title, takeaway, eyebrow, actions, footer, empty, emptyMessage, className, id, children }: ChartCardProps) {
  return (
    <SectionCard id={id} title={title} eyebrow={eyebrow} description={takeaway} actions={actions} footer={footer} className={className}>
      {empty ? <ChartEmpty message={emptyMessage} /> : children}
    </SectionCard>
  );
}

export function ChartEmpty({ message, className }: { message?: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-surface-sunken/50 px-4 py-8 text-center",
        className,
      )}
    >
      <ChartNoAxesColumn aria-hidden="true" className="size-5 text-ink-subtle" />
      <p className="max-w-xs text-sm text-ink-muted">{message ?? "Not enough data in this range yet."}</p>
    </div>
  );
}
