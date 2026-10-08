import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium tracking-normal [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        neutral: "bg-surface-muted text-ink-secondary",
        accent: "bg-accent-soft text-accent-ink",
        success: "bg-success-soft text-success-fg",
        warning: "bg-warning-soft text-warning-fg",
        danger: "bg-danger-soft text-danger-fg",
        info: "bg-info-soft text-info-fg",
        attention: "bg-attention-soft text-attention-fg",
        outline: "border border-border bg-surface text-ink-secondary",
        solid: "bg-ink text-ink-inverse",
      },
      size: {
        sm: "h-5 px-2 text-2xs",
        md: "h-6 px-2.5 text-xs",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "md",
    },
  },
);

export interface BadgeProps
  extends React.ComponentPropsWithRef<"span">,
    VariantProps<typeof badgeVariants> {
  /** Leading dot in the badge's foreground colour. */
  dot?: boolean;
}

/** Compact label for counts, categories and states. */
export function Badge({ className, variant, size, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Status                                                             */
/* ------------------------------------------------------------------ */

/**
 * Status *category* keys. Organisations can rename/add workflow statuses,
 * but every status maps to one of these categories so colour semantics
 * stay consistent across the product.
 */
export const STATUS_CATEGORIES = [
  "new",
  "ready",
  "assigned",
  "accepted",
  "in-progress",
  "submitted",
  "review",
  "revision",
  "resubmitted",
  "approved",
  "delivered",
  "completed",
  "cancelled",
] as const;

export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const STATUS_META: Record<
  StatusCategory,
  { label: string; soft: string; dot: string; solid: string }
> = {
  new: {
    label: "New",
    soft: "bg-status-new-soft text-status-new-fg",
    dot: "bg-status-new",
    solid: "bg-status-new text-white",
  },
  ready: {
    label: "Ready for assignment",
    soft: "bg-status-ready-soft text-status-ready-fg",
    dot: "bg-status-ready",
    solid: "bg-status-ready text-white",
  },
  assigned: {
    label: "Assigned",
    soft: "bg-status-assigned-soft text-status-assigned-fg",
    dot: "bg-status-assigned",
    solid: "bg-status-assigned text-white",
  },
  accepted: {
    label: "Accepted",
    soft: "bg-status-accepted-soft text-status-accepted-fg",
    dot: "bg-status-accepted",
    solid: "bg-status-accepted text-white",
  },
  "in-progress": {
    label: "In progress",
    soft: "bg-status-in-progress-soft text-status-in-progress-fg",
    dot: "bg-status-in-progress",
    solid: "bg-status-in-progress text-white",
  },
  submitted: {
    label: "Submitted for review",
    soft: "bg-status-submitted-soft text-status-submitted-fg",
    dot: "bg-status-submitted",
    solid: "bg-status-submitted text-white",
  },
  review: {
    label: "Review required",
    soft: "bg-status-review-soft text-status-review-fg",
    dot: "bg-status-review",
    solid: "bg-status-review text-white",
  },
  revision: {
    label: "Revision required",
    soft: "bg-status-revision-soft text-status-revision-fg",
    dot: "bg-status-revision",
    solid: "bg-status-revision text-white",
  },
  resubmitted: {
    label: "Resubmitted",
    soft: "bg-status-resubmitted-soft text-status-resubmitted-fg",
    dot: "bg-status-resubmitted",
    solid: "bg-status-resubmitted text-white",
  },
  approved: {
    label: "Approved",
    soft: "bg-status-approved-soft text-status-approved-fg",
    dot: "bg-status-approved",
    solid: "bg-status-approved text-white",
  },
  delivered: {
    label: "Delivered",
    soft: "bg-status-delivered-soft text-status-delivered-fg",
    dot: "bg-status-delivered",
    solid: "bg-status-delivered text-white",
  },
  completed: {
    label: "Completed",
    soft: "bg-status-completed-soft text-status-completed-fg",
    dot: "bg-status-completed",
    solid: "bg-status-completed text-white",
  },
  cancelled: {
    label: "Cancelled",
    soft: "bg-status-cancelled-soft text-status-cancelled-fg",
    dot: "bg-status-cancelled",
    solid: "bg-status-cancelled text-white",
  },
};

export function isStatusCategory(value: string): value is StatusCategory {
  return (STATUS_CATEGORIES as readonly string[]).includes(value);
}

export interface StatusBadgeProps extends Omit<React.ComponentPropsWithRef<"span">, "children"> {
  /** Status category key (unknown values fall back to `new`). */
  status: StatusCategory | string;
  /** Display label — defaults to the category's canonical label. */
  label?: React.ReactNode;
  size?: "sm" | "md";
  /** Filled pill instead of the soft tint. */
  solid?: boolean;
  /** Hide the coloured dot. */
  hideDot?: boolean;
}

/** Workflow status pill: coloured dot + label, tinted by category. */
export function StatusBadge({
  status,
  label,
  size = "md",
  solid = false,
  hideDot = false,
  className,
  ...props
}: StatusBadgeProps) {
  const key: StatusCategory = isStatusCategory(status) ? status : "new";
  const meta = STATUS_META[key];
  return (
    <span
      data-status={key}
      className={cn(
        badgeVariants({ size }),
        solid ? meta.solid : meta.soft,
        className,
      )}
      {...props}
    >
      {!hideDot ? (
        <span
          aria-hidden="true"
          className={cn("size-1.5 rounded-full", solid ? "bg-white/80" : meta.dot)}
        />
      ) : null}
      {label ?? meta.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Priority                                                           */
/* ------------------------------------------------------------------ */

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type PriorityKey = (typeof PRIORITIES)[number];

export const PRIORITY_META: Record<PriorityKey, { label: string; soft: string; dot: string; bars: number }> =
  {
    low: { label: "Low", soft: "bg-priority-low-soft text-priority-low-fg", dot: "bg-priority-low", bars: 1 },
    normal: {
      label: "Normal",
      soft: "bg-priority-normal-soft text-priority-normal-fg",
      dot: "bg-priority-normal",
      bars: 2,
    },
    high: { label: "High", soft: "bg-priority-high-soft text-priority-high-fg", dot: "bg-priority-high", bars: 3 },
    urgent: {
      label: "Urgent",
      soft: "bg-priority-urgent-soft text-priority-urgent-fg",
      dot: "bg-priority-urgent",
      bars: 4,
    },
  };

export function isPriorityKey(value: string): value is PriorityKey {
  return (PRIORITIES as readonly string[]).includes(value);
}

export interface PriorityBadgeProps extends Omit<React.ComponentPropsWithRef<"span">, "children"> {
  priority: PriorityKey | string;
  label?: React.ReactNode;
  size?: "sm" | "md";
  /** Show just the signal bars with a tooltip-style title (for dense tables). */
  compact?: boolean;
}

/** Priority pill with a 4-step signal-bar glyph. */
export function PriorityBadge({
  priority,
  label,
  size = "md",
  compact = false,
  className,
  ...props
}: PriorityBadgeProps) {
  const key: PriorityKey = isPriorityKey(priority) ? priority : "normal";
  const meta = PRIORITY_META[key];
  const bars = (
    <span aria-hidden="true" className="flex items-end gap-px">
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className={cn(
            "w-[3px] rounded-[1px]",
            n <= meta.bars ? meta.dot : "bg-current opacity-20",
          )}
          style={{ height: `${4 + n * 2}px` }}
        />
      ))}
    </span>
  );

  if (compact) {
    return (
      <span
        title={meta.label}
        aria-label={`Priority: ${meta.label}`}
        data-priority={key}
        className={cn("inline-flex items-center text-ink-muted", className)}
        {...props}
      >
        {bars}
      </span>
    );
  }

  return (
    <span
      data-priority={key}
      className={cn(badgeVariants({ size }), meta.soft, className)}
      {...props}
    >
      {bars}
      {label ?? meta.label}
    </span>
  );
}
