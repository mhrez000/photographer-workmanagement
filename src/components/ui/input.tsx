import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const inputVariants = cva(
  [
    "peer w-full min-w-0 appearance-none bg-surface text-ink shadow-xs",
    "border border-border placeholder:text-ink-subtle",
    "transition-[border-color,box-shadow,background-color] duration-(--motion-fast) ease-out-soft",
    "hover:border-border-hover",
    "focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20",
    "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted disabled:shadow-none",
    "read-only:bg-surface-sunken",
    "aria-invalid:border-danger aria-invalid:focus:ring-danger/20",
  ],
  {
    variants: {
      size: {
        sm: "h-8 rounded-sm px-2.5 text-sm",
        md: "h-9 rounded-md px-3 text-base",
        lg: "h-10 rounded-md px-3.5 text-md",
      },
      mono: {
        true: "font-mono numeric",
        false: "",
      },
    },
    defaultVariants: {
      size: "md",
      mono: false,
    },
  },
);

export interface InputProps
  extends Omit<React.ComponentPropsWithRef<"input">, "size">,
    VariantProps<typeof inputVariants> {
  /** Marks the field invalid (sets `aria-invalid`). */
  invalid?: boolean;
  /** Adornment rendered inside the field on the left (icon or text). */
  leading?: React.ReactNode;
  /** Adornment rendered inside the field on the right (icon or text). */
  trailing?: React.ReactNode;
  /** Class for the wrapper when adornments are present. */
  wrapperClassName?: string;
}

const adornment =
  "pointer-events-none absolute inset-y-0 flex items-center text-ink-subtle peer-focus:text-ink-muted [&_svg]:size-4 text-sm";

/** Text input. Use `leading`/`trailing` for inline icons or units. */
export function Input({
  className,
  size,
  mono,
  invalid,
  leading,
  trailing,
  wrapperClassName,
  type = "text",
  ...props
}: InputProps) {
  const field = (
    <input
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        inputVariants({ size, mono }),
        leading && (size === "sm" ? "pl-8" : "pl-9"),
        trailing && (size === "sm" ? "pr-8" : "pr-9"),
        className,
      )}
      {...props}
    />
  );

  if (!leading && !trailing) return field;

  return (
    <div className={cn("relative w-full", wrapperClassName)}>
      {field}
      {leading ? <span className={cn(adornment, "left-0 pl-3")}>{leading}</span> : null}
      {trailing ? <span className={cn(adornment, "right-0 pr-3")}>{trailing}</span> : null}
    </div>
  );
}
