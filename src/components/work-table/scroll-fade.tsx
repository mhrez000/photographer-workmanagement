"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface ScrollFadeProps {
  children: React.ReactNode;
  className?: string;
  /** Gradient start colour class (match the background behind the scroller). */
  fadeClassName?: string;
}

/**
 * Wraps one horizontal scroller (its first child — e.g. `<Table>`'s scroll
 * wrapper or an `overflow-x-auto` nav) and fades its right edge while there
 * is more content to the right, so cut-off columns / tabs read as "scroll
 * for more" instead of silently missing.
 */
export function ScrollFade({ children, className, fadeClassName = "from-surface" }: ScrollFadeProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState({ more: false, inset: 0 });

  React.useEffect(() => {
    const el = ref.current?.firstElementChild;
    if (!(el instanceof HTMLElement)) return;
    const update = () => {
      const more = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      // Keep the fade clear of a vertical scrollbar.
      const inset = Math.max(0, el.offsetWidth - el.clientWidth - el.clientLeft * 2);
      setState((s) => (s.more === more && s.inset === inset ? s : { more, inset }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className={cn("relative", className)}>
      {children}
      <div
        aria-hidden="true"
        data-scroll-fade={state.more ? "right" : undefined}
        className={cn(
          "pointer-events-none absolute inset-y-0 z-30 w-12 bg-gradient-to-l to-transparent transition-opacity duration-(--motion-fast) print:hidden",
          fadeClassName,
          state.more ? "opacity-100" : "opacity-0",
        )}
        style={{ right: state.inset }}
      />
    </div>
  );
}
