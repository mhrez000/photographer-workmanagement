import * as React from "react";
import { cn } from "@/lib/utils";

export interface LabelProps extends React.ComponentPropsWithRef<"label"> {
  required?: boolean;
  /** Renders a quiet "Optional" suffix. */
  optional?: boolean;
  /** Small secondary text on the right (e.g. character count, link). */
  hint?: React.ReactNode;
}

/** Form label: 13px, medium weight, with required/optional affordances. */
export function Label({ className, children, required, optional, hint, ...props }: LabelProps) {
  return (
    <label
      className={cn(
        "flex items-baseline justify-between gap-3 text-sm font-medium leading-5 text-ink",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-60",
        className,
      )}
      {...props}
    >
      <span className="inline-flex items-baseline gap-1">
        {children}
        {required ? (
          <span aria-hidden="true" className="text-danger">
            *
          </span>
        ) : null}
        {optional ? <span className="font-normal text-ink-subtle">· Optional</span> : null}
      </span>
      {hint ? <span className="text-xs font-normal text-ink-muted">{hint}</span> : null}
    </label>
  );
}
