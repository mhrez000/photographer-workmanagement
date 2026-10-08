import * as React from "react";
import { cn } from "@/lib/utils";

export interface PageContainerProps extends React.ComponentPropsWithRef<"div"> {
  /** `default` 1440px · `narrow` 768px (forms, settings) · `full` no max-width (kanban, timeline). */
  width?: "default" | "narrow" | "full";
  /** Remove vertical padding (e.g. full-bleed boards). */
  flush?: boolean;
}

const widths = {
  default: "max-w-[1440px]",
  narrow: "max-w-3xl",
  full: "max-w-none",
} as const;

/** Consistent page gutters and max-width. Stack sections with `gap`. */
export function PageContainer({ width = "default", flush = false, className, ...props }: PageContainerProps) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-6 px-4 sm:px-6 lg:px-8",
        !flush && "py-5 lg:py-6",
        widths[width],
        className,
      )}
      {...props}
    />
  );
}
