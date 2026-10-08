"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface RailTooltipProps {
  content: React.ReactNode;
  children: React.ReactElement<Record<string, unknown>>;
  className?: string;
}

/**
 * Tooltip for the collapsed icon rail. Rendered `position: fixed` from the
 * trigger's measured rect so it escapes the sidebar's overflow clipping.
 * Shows on hover and keyboard focus; hides on leave, blur and Escape.
 */
export function RailTooltip({ content, children, className }: RailTooltipProps) {
  const id = React.useId();
  const [anchor, setAnchor] = React.useState<{ top: number; left: number } | null>(null);

  const show = (event: React.SyntheticEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setAnchor({ top: rect.top + rect.height / 2, left: rect.right + 10 });
  };
  const hide = () => setAnchor(null);

  return (
    <span
      className="relative flex w-full justify-center"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape") hide();
      }}
    >
      {React.cloneElement(children, { "aria-describedby": id })}
      <span
        role="tooltip"
        id={id}
        hidden={anchor === null}
        style={anchor ? { top: anchor.top, left: anchor.left } : undefined}
        className={cn(
          "pointer-events-none fixed z-50 w-max max-w-56 -translate-y-1/2 rounded-sm bg-ink px-2 py-1 text-xs font-medium leading-4 text-ink-inverse shadow-md",
          "animate-fade-in",
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}
