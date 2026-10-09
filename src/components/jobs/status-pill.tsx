import * as React from "react";
import { STATUS_CATEGORY_META, type StatusCategory } from "@/lib/constants";
import type { StatusRef } from "@/lib/types";
import { cn, type CSSVariables } from "@/lib/utils";

/** Accepts a full StatusRef or the minimal subset a view model carries. */
export type StatusLikeRef = Pick<StatusRef, "name" | "category"> & { colour?: string | null };

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The workflow status colour, falling back to the category colour. */
export function statusColour(status: { category: StatusCategory; colour?: string | null }): string {
  const colour = status.colour?.trim();
  if (colour && (HEX.test(colour) || /^(rgb|hsl|oklch)\(/i.test(colour))) return colour;
  return STATUS_CATEGORY_META[status.category]?.hex ?? "#64748b";
}

/** Inline tint for any CSS colour: soft background, readable text, solid dot. */
export function tintStyle(colour: string): CSSVariables {
  return {
    "--pill": colour,
    backgroundColor: "color-mix(in oklab, var(--pill) 13%, var(--surface))",
    color: "color-mix(in oklab, var(--pill) 72%, var(--ink))",
    boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--pill) 18%, transparent)",
  };
}

const pillSizes = {
  xs: "h-5 gap-1 px-1.5 text-2xs",
  sm: "h-5 gap-1.5 px-2 text-2xs",
  md: "h-6 gap-1.5 px-2.5 text-xs",
} as const;

export interface StatusPillProps {
  status: StatusLikeRef;
  size?: keyof typeof pillSizes;
  /** Dot only (dense tables / kanban headers): the name moves to the tooltip. */
  dotOnly?: boolean;
  className?: string;
}

/** Workflow status pill: the status's own colour dot + name (falls back to the category colour). */
export function StatusPill({ status, size = "md", dotOnly = false, className }: StatusPillProps) {
  const colour = statusColour(status);
  const categoryLabel = STATUS_CATEGORY_META[status.category]?.label;
  const title = categoryLabel && categoryLabel.toLowerCase() !== status.name.toLowerCase() ? `${status.name} · ${categoryLabel}` : status.name;

  if (dotOnly) {
    return (
      <span
        role="img"
        aria-label={status.name}
        title={title}
        data-category={status.category}
        className={cn("inline-block size-2.5 shrink-0 rounded-full ring-2 ring-surface", className)}
        style={{ backgroundColor: colour }}
      />
    );
  }

  return (
    <span
      data-category={status.category}
      title={title}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center whitespace-nowrap rounded-full font-medium leading-none",
        pillSizes[size],
        className,
      )}
      style={tintStyle(colour)}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: colour }} />
      <span className="truncate">{status.name}</span>
    </span>
  );
}

export interface CategoryPillProps {
  category: StatusCategory;
  /** Override the label (defaults to the category label, e.g. "In review"). */
  label?: React.ReactNode;
  size?: keyof typeof pillSizes;
  /** Optional count shown after the label (filters, column headers). */
  count?: number;
  className?: string;
}

/** Status *category* pill (filters, KPI legends, kanban column headers). */
export function CategoryPill({ category, label, size = "md", count, className }: CategoryPillProps) {
  const meta = STATUS_CATEGORY_META[category];
  const colour = meta?.hex ?? "#64748b";
  return (
    <span
      data-category={category}
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full font-medium leading-none",
        pillSizes[size],
        className,
      )}
      style={tintStyle(colour)}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: colour }} />
      {label ?? meta?.label ?? category}
      {count !== undefined ? <span className="numeric opacity-70">{count}</span> : null}
    </span>
  );
}
