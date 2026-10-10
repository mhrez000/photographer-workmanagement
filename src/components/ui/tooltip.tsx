import * as React from "react";
import { cn } from "@/lib/utils";

export interface TooltipProps {
  content: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  /**
   * Horizontal alignment for `top` / `bottom` tooltips. Use `end` for triggers
   * at the right edge of the layout (the tooltip then grows leftwards and never
   * widens the page), `start` for the left edge. Default `center`.
   */
  align?: "start" | "center" | "end";
  /** The trigger. A single focusable element works best. */
  children: React.ReactElement<Record<string, unknown>>;
  /** Hide the tooltip entirely (keeps the children as-is). */
  disabled?: boolean;
  className?: string;
  /** Wrapper class (the relative container). */
  wrapperClassName?: string;
}

const placements: Record<NonNullable<TooltipProps["side"]>, string> = {
  top: "bottom-full mb-2 origin-bottom",
  bottom: "top-full mt-2 origin-top",
  left: "right-full top-1/2 mr-2 -translate-y-1/2 origin-right",
  right: "left-full top-1/2 ml-2 -translate-y-1/2 origin-left",
};

const alignments: Record<NonNullable<TooltipProps["align"]>, string> = {
  start: "left-0",
  center: "left-1/2 -translate-x-1/2",
  end: "right-0",
};

/**
 * Pure CSS/ARIA tooltip: shows on hover and keyboard focus, no JS.
 * The child receives `aria-describedby`.
 */
export function Tooltip({ content, side = "top", align = "center", children, disabled, className, wrapperClassName }: TooltipProps) {
  const id = React.useId();
  if (disabled || !content) return children;

  const child = React.cloneElement(children, { "aria-describedby": id });

  return (
    <span className={cn("group/tooltip relative inline-flex", wrapperClassName)}>
      {child}
      <span
        role="tooltip"
        id={id}
        className={cn(
          "pointer-events-none absolute z-(--z-popover) w-max max-w-64 rounded-sm bg-ink px-2 py-1 text-xs font-medium leading-4 text-ink-inverse shadow-md",
          // Closed = invisible, not just transparent: a transparent tooltip still counts as shown for
          // assistive tech and hit-testing (two "visible" tooltips at once). `visibility` is in the
          // transition so it flips after the fade-out.
          "invisible opacity-0 scale-95 transition-[opacity,transform,visibility] duration-(--motion-fast) ease-out-soft",
          "group-hover/tooltip:visible group-hover/tooltip:opacity-100 group-hover/tooltip:scale-100 group-hover/tooltip:delay-300",
          "group-has-[:focus-visible]/tooltip:visible group-has-[:focus-visible]/tooltip:opacity-100 group-has-[:focus-visible]/tooltip:scale-100",
          placements[side],
          side === "top" || side === "bottom" ? alignments[align] : null,
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}
