"use client";

import * as React from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps extends Omit<React.ComponentPropsWithRef<"input">, "type" | "size"> {
  /** Optional inline label (rendered to the right). */
  label?: React.ReactNode;
  /** Secondary line under the label. */
  description?: React.ReactNode;
  /** Partially-checked state (e.g. "select all" with some rows selected). */
  indeterminate?: boolean;
  size?: "sm" | "md";
  invalid?: boolean;
  /** Class for the outer label wrapper. */
  wrapperClassName?: string;
}

/**
 * Checkbox built on a native input (keyboard, forms and a11y for free)
 * with a custom drawn box. Supports `indeterminate`.
 */
export function Checkbox({
  label,
  description,
  indeterminate = false,
  size = "md",
  invalid,
  className,
  wrapperClassName,
  id,
  ref,
  ...props
}: CheckboxProps) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const setRefs = React.useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const boxSize = size === "sm" ? "size-3.5" : "size-4";
  const iconBase =
    "pointer-events-none absolute inset-0 m-auto size-3 stroke-[3] text-accent-fg opacity-0 transition-opacity duration-(--motion-fast)";

  const box = (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center", boxSize)}>
      <input
        ref={setRefs}
        id={inputId}
        type="checkbox"
        aria-invalid={invalid || undefined}
        className={cn(
          "peer absolute inset-0 z-10 m-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed",
          className,
        )}
        {...props}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 rounded-xs border border-border-strong bg-surface shadow-xs",
          "transition-[background-color,border-color,outline-color] duration-(--motion-fast) ease-out-soft",
          "peer-hover:border-border-hover",
          "peer-checked:border-accent peer-checked:bg-accent peer-indeterminate:border-accent peer-indeterminate:bg-accent",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
          "peer-disabled:opacity-50",
          "peer-aria-invalid:border-danger",
        )}
      />
      <Check aria-hidden="true" className={cn(iconBase, "peer-checked:opacity-100")} />
      <Minus aria-hidden="true" className={cn(iconBase, "peer-indeterminate:opacity-100")} />
    </span>
  );

  if (!label && !description) return box;

  return (
    <label
      htmlFor={inputId}
      className={cn(
        "group inline-flex cursor-pointer items-start gap-2.5 has-[input:disabled]:cursor-not-allowed",
        wrapperClassName,
      )}
    >
      <span className={cn("flex items-center", size === "sm" ? "h-5" : "h-[22px]")}>{box}</span>
      <span className="flex min-w-0 flex-col">
        {label ? (
          <span className="text-base text-ink group-has-[input:disabled]:text-ink-muted">{label}</span>
        ) : null}
        {description ? <span className="text-sm text-ink-muted">{description}</span> : null}
      </span>
    </label>
  );
}
