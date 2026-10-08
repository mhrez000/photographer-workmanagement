import * as React from "react";
import { cn } from "@/lib/utils";

export interface ScrollAreaProps extends React.ComponentPropsWithRef<"div"> {
  orientation?: "vertical" | "horizontal" | "both";
  maxHeight?: string | number;
  /** Fade the edges to hint at more content. */
  fade?: boolean;
}

/** Overflow container with thin scrollbars and optional edge fades. */
export function ScrollArea({
  orientation = "vertical",
  maxHeight,
  fade = false,
  className,
  style,
  children,
  ...props
}: ScrollAreaProps) {
  const overflow = {
    vertical: "overflow-y-auto overflow-x-hidden",
    horizontal: "overflow-x-auto overflow-y-hidden",
    both: "overflow-auto",
  }[orientation];

  return (
    <div
      className={cn(
        "relative min-h-0 min-w-0 scrollbar-thin",
        overflow,
        fade &&
          orientation === "vertical" &&
          "[mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)]",
        fade &&
          orientation === "horizontal" &&
          "[mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]",
        className,
      )}
      style={{ ...(maxHeight !== undefined ? { maxHeight } : {}), ...style }}
      {...props}
    >
      {children}
    </div>
  );
}
