import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<React.ComponentPropsWithRef<"select">, "size"> {
  size?: "sm" | "md" | "lg";
  invalid?: boolean;
  /** Convenience: render options from data instead of children. */
  options?: SelectOption[];
  /** Placeholder option (rendered disabled + selected when value is empty). */
  placeholder?: string;
  wrapperClassName?: string;
}

const sizeClasses = {
  sm: "h-8 pointer-coarse:h-9 rounded-sm pl-2.5 pr-8 text-sm",
  md: "h-9 pointer-coarse:h-10 rounded-md pl-3 pr-9 text-base",
  lg: "h-10 rounded-md pl-3.5 pr-9 text-md",
} as const;

/** Native `<select>` with consistent styling and a chevron affordance. */
export function Select({
  className,
  wrapperClassName,
  size = "md",
  invalid,
  options,
  placeholder,
  children,
  ...props
}: SelectProps) {
  return (
    <div className={cn("relative w-full", wrapperClassName)}>
      <select
        aria-invalid={invalid || undefined}
        className={cn(
          "peer w-full min-w-0 appearance-none truncate border border-border bg-surface text-ink shadow-xs",
          "transition-[border-color,box-shadow] duration-(--motion-fast) ease-out-soft hover:border-border-hover",
          "focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20",
          "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted disabled:shadow-none",
          "aria-invalid:border-danger aria-invalid:focus:ring-danger/20",
          "invalid:text-ink-subtle",
          sizeClasses[size],
          className,
        )}
        data-autofocus={props.autoFocus ? "" : undefined}
        {...props}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-subtle peer-focus:text-ink-muted"
      />
    </div>
  );
}
