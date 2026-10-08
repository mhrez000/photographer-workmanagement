import * as React from "react";
import { clamp, cn } from "@/lib/utils";

export interface ProgressProps extends Omit<React.ComponentPropsWithRef<"div">, "children"> {
  value: number;
  max?: number;
  tone?: "accent" | "success" | "warning" | "danger" | "info" | "neutral";
  size?: "xs" | "sm" | "md";
  /** Accessible label (and optional visible label when `showLabel`). */
  label?: string;
  showLabel?: boolean;
  /** Show "73%" on the right. */
  showValue?: boolean;
  /** Automatically pick a tone from the ratio (danger < 34% < warning < 67% < success). */
  auto?: boolean;
}

const toneClasses: Record<NonNullable<ProgressProps["tone"]>, string> = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-ink-subtle",
};

const sizes = { xs: "h-1", sm: "h-1.5", md: "h-2" } as const;

/** Determinate progress bar. */
export function Progress({
  value,
  max = 100,
  tone = "accent",
  size = "sm",
  label,
  showLabel = false,
  showValue = false,
  auto = false,
  className,
  ...props
}: ProgressProps) {
  const ratio = max > 0 ? clamp(value / max, 0, 1) : 0;
  const percent = Math.round(ratio * 100);
  const resolvedTone = auto ? (ratio < 0.34 ? "danger" : ratio < 0.67 ? "warning" : "success") : tone;

  return (
    <div className={cn("flex w-full flex-col gap-1", className)} {...props}>
      {showLabel || showValue ? (
        <div className="flex items-center justify-between gap-3 text-xs">
          {showLabel && label ? <span className="text-ink-secondary">{label}</span> : <span />}
          {showValue ? <span className="numeric text-ink-muted">{percent}%</span> : null}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={clamp(value, 0, max)}
        aria-valuetext={`${percent}%`}
        className={cn("w-full overflow-hidden rounded-full bg-surface-muted", sizes[size])}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-(--motion-slow) ease-out-soft",
            toneClasses[resolvedTone],
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
