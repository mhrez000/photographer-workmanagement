"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface SwitchProps
  extends Omit<React.ComponentPropsWithRef<"button">, "onChange" | "type" | "role" | "value"> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** When set, a hidden input is rendered so the switch participates in forms. */
  name?: string;
  value?: string;
  size?: "sm" | "md";
  label?: React.ReactNode;
  description?: React.ReactNode;
  /** Put the label before the control. */
  labelPosition?: "start" | "end";
  wrapperClassName?: string;
}

/** Accessible toggle (`role="switch"`), controlled or uncontrolled. */
export function Switch({
  checked,
  defaultChecked = false,
  onCheckedChange,
  name,
  value = "on",
  size = "md",
  label,
  description,
  labelPosition = "end",
  className,
  wrapperClassName,
  disabled,
  id,
  onClick,
  ...props
}: SwitchProps) {
  const [internal, setInternal] = React.useState(defaultChecked);
  const isControlled = checked !== undefined;
  const isOn = isControlled ? checked : internal;
  const generatedId = React.useId();
  const switchId = id ?? generatedId;
  const labelId = `${switchId}-label`;
  const descId = `${switchId}-desc`;

  const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || disabled) return;
    const next = !isOn;
    if (!isControlled) setInternal(next);
    onCheckedChange?.(next);
  };

  const track = size === "sm" ? "h-4.5 w-8" : "h-5.5 w-10";
  const thumb = size === "sm" ? "size-3.5" : "size-4.5";
  const travel = size === "sm" ? "translate-x-3.5" : "translate-x-4.5";

  const control = (
    <button
      type="button"
      role="switch"
      id={switchId}
      aria-checked={isOn}
      aria-labelledby={label ? labelId : undefined}
      aria-describedby={description ? descId : undefined}
      disabled={disabled}
      data-state={isOn ? "checked" : "unchecked"}
      onClick={toggle}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5",
        "transition-colors duration-(--motion-base) ease-out-soft focus-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        isOn ? "bg-accent" : "bg-border-strong hover:bg-border-hover",
        track,
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-sm",
          "transition-transform duration-(--motion-base) ease-spring",
          thumb,
          isOn ? travel : "translate-x-0",
        )}
      />
      {name ? <input type="hidden" name={name} value={isOn ? value : ""} /> : null}
    </button>
  );

  if (!label && !description) return control;

  const text = (
    <span className="flex min-w-0 flex-col">
      {label ? (
        <span id={labelId} className={cn("text-base text-ink", disabled && "text-ink-muted")}>
          {label}
        </span>
      ) : null}
      {description ? (
        <span id={descId} className="text-sm text-ink-muted">
          {description}
        </span>
      ) : null}
    </span>
  );

  return (
    <label
      htmlFor={switchId}
      className={cn(
        "inline-flex items-start gap-3",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
        labelPosition === "start" && "flex-row-reverse justify-between",
        wrapperClassName,
      )}
    >
      <span className="flex h-[22px] items-center">{control}</span>
      {text}
    </label>
  );
}
