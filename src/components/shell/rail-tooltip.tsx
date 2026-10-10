"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const noopSubscribe = () => () => {};

export interface RailTooltipProps {
  content: React.ReactNode;
  children: React.ReactElement<Record<string, unknown>>;
  className?: string;
}

/**
 * Tooltip for the collapsed icon rail. Rendered `position: fixed` from the
 * trigger's measured rect so it escapes the sidebar's overflow clipping, and
 * portaled to `document.body` so its `z-(--z-popover)` is evaluated at the root:
 * the sidebar (`z-(--z-shell)`) is its own stacking context, and a tooltip that
 * reaches into the topbar band would otherwise paint under the raised topbar
 * (docs/ROLES.md §11.1). Shows on hover and keyboard (`:focus-visible`) focus; hides on leave,
 * blur and Escape.
 */
export function RailTooltip({ content, children, className }: RailTooltipProps) {
  const id = React.useId();
  const [anchor, setAnchor] = React.useState<{ top: number; left: number } | null>(null);

  const show = (event: React.SyntheticEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setAnchor({ top: rect.top + rect.height / 2, left: rect.right + 10 });
  };
  const hide = () => setAnchor(null);
  // false during SSR / hydration, true on the client: the portal target exists.
  const onClient = React.useSyncExternalStore(noopSubscribe, () => true, () => false);

  const tooltip = (
    <span
      role="tooltip"
      id={id}
      hidden={anchor === null}
      style={anchor ? { top: anchor.top, left: anchor.left } : undefined}
      className={cn(
        "pointer-events-none fixed z-(--z-popover) w-max max-w-56 -translate-y-1/2 rounded-sm bg-ink px-2 py-1 text-xs font-medium leading-4 text-ink-inverse shadow-md",
        "animate-fade-in",
        className,
      )}
    >
      {content}
    </span>
  );

  return (
    <span
      className="relative flex w-full justify-center"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={(event) => {
        // Keyboard focus only: a mouse click also focuses the button, and that tooltip would linger
        // next to the one under the pointer (two tooltips at once).
        const target = event.target as HTMLElement;
        if (typeof target.matches !== "function" || target.matches(":focus-visible")) show(event);
      }}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape") hide();
      }}
    >
      {React.cloneElement(children, { "aria-describedby": id })}
      {onClient ? createPortal(tooltip, document.body) : tooltip}
    </span>
  );
}
