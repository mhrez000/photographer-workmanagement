import * as React from "react";
import { cn } from "@/lib/utils";

export interface TooltipProps {
  content: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  /** The trigger. A single focusable element works best. */
  children: React.ReactElement<Record<string, unknown>>;
  /** Hide the tooltip entirely (keeps the children as-is). */
  disabled?: boolean;
  className?: string;
  /** Wrapper class (the relative container). */
  wrapperClassName?: string;
}

const placements: Record<NonNullable<TooltipProps["side"]>, string> = {
  top: "bottom-full left-1/2 mb-2 -translate-x-1/2 origin-bottom",
  bottom: "top-full left-1/2 mt-2 -translate-x-1/2 origin-top",
  left: "right-full top-1/2 mr-2 -translate-y-1/2 origin-right",
  right: "left-full top-1/2 ml-2 -translate-y-1/2 origin-left",
};

/**
 * Pure CSS/ARIA tooltip: shows on hover and keyboard focus, no JS.
 * The child receives `aria-describedby`.
 */
export function Tooltip({ content, side = "top", children, disabled, className, wrapperClassName }: TooltipProps) {
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
          "pointer-events-none absolute z-50 w-max max-w-64 rounded-sm bg-ink px-2 py-1 text-xs font-medium leading-4 text-ink-inverse shadow-md",
          "opacity-0 scale-95 transition-[opacity,transform] duration-(--motion-fast) ease-out-soft",
          "group-hover/tooltip:opacity-100 group-hover/tooltip:scale-100 group-hover/tooltip:delay-300",
          "group-has-[:focus-visible]/tooltip:opacity-100 group-has-[:focus-visible]/tooltip:scale-100",
          placements[side],
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}
