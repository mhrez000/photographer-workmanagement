import * as React from "react";
import { cn } from "@/lib/utils";

export interface KbdProps extends React.ComponentPropsWithRef<"kbd"> {
  /** Render a chord: `["⌘", "K"]` → ⌘ K */
  keys?: string[];
  size?: "sm" | "md";
}

/** Keyboard key cap. */
export function Kbd({ keys, size = "sm", className, children, ...props }: KbdProps) {
  const content = keys ? keys.join(" ") : children;
  return (
    <kbd
      className={cn(
        "inline-flex select-none items-center justify-center gap-0.5 rounded-xs border border-border bg-surface px-1.5 font-sans font-medium text-ink-muted shadow-[inset_0_-1px_0_var(--border)]",
        size === "sm" ? "h-5 min-w-5 text-2xs" : "h-6 min-w-6 text-xs",
        className,
      )}
      {...props}
    >
      {content}
    </kbd>
  );
}
