"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { moveFocus } from "./use-dismissable";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Icon-only option: `label` becomes the accessible name. */
  iconOnly?: boolean;
}

export interface SegmentedControlProps<T extends string>
  extends Omit<React.ComponentPropsWithRef<"div">, "onChange" | "defaultValue"> {
  options: SegmentedOption<T>[];
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  size?: "sm" | "md";
  /** Accessible name for the group. */
  "aria-label": string;
  fullWidth?: boolean;
}

/** Radio-group style switcher (view modes, ranges). Arrow keys move selection. */
export function SegmentedControl<T extends string>({
  options,
  value,
  defaultValue,
  onValueChange,
  size = "md",
  fullWidth = false,
  className,
  onKeyDown,
  ...props
}: SegmentedControlProps<T>) {
  const [internal, setInternal] = React.useState<T | undefined>(defaultValue ?? options[0]?.value);
  const isControlled = value !== undefined;
  const current = isControlled ? value : internal;
  const ref = React.useRef<HTMLDivElement>(null);

  const select = (next: T) => {
    if (!isControlled) setInternal(next);
    onValueChange?.(next);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const map: Record<string, "next" | "prev" | "first" | "last"> = {
      ArrowRight: "next",
      ArrowDown: "next",
      ArrowLeft: "prev",
      ArrowUp: "prev",
      Home: "first",
      End: "last",
    };
    const dir = map[event.key];
    if (!dir) return;
    event.preventDefault();
    moveFocus(ref.current, '[role="radio"]', dir);
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const next = active.dataset.value as T | undefined;
      if (next !== undefined) select(next);
    }
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      onKeyDown={handleKeyDown}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md bg-surface-muted p-0.5",
        fullWidth && "flex w-full",
        className,
      )}
      {...props}
    >
      {options.map((option) => {
        const selected = option.value === current;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.iconOnly && typeof option.label === "string" ? option.label : undefined}
            title={option.iconOnly && typeof option.label === "string" ? option.label : undefined}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            data-value={option.value}
            data-state={selected ? "on" : "off"}
            onClick={() => select(option.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium text-ink-muted",
              "transition-[background-color,color,box-shadow] duration-(--motion-fast) ease-out-soft focus-ring",
              "hover:text-ink disabled:pointer-events-none disabled:opacity-50",
              "data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-xs",
              "[&_svg]:size-4 [&_svg]:shrink-0",
              size === "sm" ? "h-6.5 px-2 text-xs" : "h-7.5 px-3 text-sm",
              option.iconOnly && (size === "sm" ? "w-7 px-0" : "w-8 px-0"),
              fullWidth && "flex-1",
            )}
          >
            {option.icon}
            {!option.iconOnly ? option.label : null}
          </button>
        );
      })}
    </div>
  );
}
