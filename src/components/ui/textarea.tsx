import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps extends React.ComponentPropsWithRef<"textarea"> {
  invalid?: boolean;
  /** Disable manual resize handle. */
  fixed?: boolean;
}

/** Multi-line text input. Defaults to 3 rows and vertical resize. */
export function Textarea({ className, invalid, fixed, rows = 3, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full min-w-0 appearance-none rounded-md border border-border bg-surface px-3 py-2 text-base text-ink shadow-xs",
        "placeholder:text-ink-subtle hover:border-border-hover",
        "transition-[border-color,box-shadow] duration-(--motion-fast) ease-out-soft",
        "focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20",
        "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted disabled:shadow-none",
        "aria-invalid:border-danger aria-invalid:focus:ring-danger/20",
        fixed ? "resize-none" : "resize-y",
        className,
      )}
      {...props}
    />
  );
}
