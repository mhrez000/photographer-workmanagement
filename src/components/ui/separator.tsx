import * as React from "react";
import { cn } from "@/lib/utils";

export interface SeparatorProps extends React.ComponentPropsWithRef<"div"> {
  orientation?: "horizontal" | "vertical";
  /** Optional centred label ("or", "Today", …). */
  label?: React.ReactNode;
  /** Purely visual (no semantic separator role). */
  decorative?: boolean;
}

/** Hairline divider, optionally with a centred label. */
export function Separator({
  orientation = "horizontal",
  label,
  decorative = false,
  className,
  ...props
}: SeparatorProps) {
  const a11y = decorative
    ? { role: "none" as const }
    : { role: "separator" as const, "aria-orientation": orientation };

  if (orientation === "vertical") {
    return (
      <div
        {...a11y}
        className={cn("h-full w-px self-stretch bg-border", className)}
        {...props}
      />
    );
  }

  if (label) {
    return (
      <div {...a11y} className={cn("flex items-center gap-3 text-xs text-ink-subtle", className)} {...props}>
        <span className="h-px flex-1 bg-border" />
        <span className="shrink-0">{label}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  return <div {...a11y} className={cn("h-px w-full bg-border", className)} {...props} />;
}
