import * as React from "react";
import { cn } from "@/lib/utils";

export interface CardProps extends React.ComponentPropsWithRef<"div"> {
  /** Lift the card on hover (use for clickable cards). */
  interactive?: boolean;
  /** Remove the default padding on CardContent children (for tables). */
  flush?: boolean;
  tone?: "default" | "muted" | "accent" | "attention" | "danger";
}

const tones: Record<NonNullable<CardProps["tone"]>, string> = {
  default: "bg-surface border-border",
  muted: "bg-surface-sunken border-border",
  accent: "bg-accent-soft/60 border-accent/20",
  attention: "bg-attention-soft/60 border-attention/25",
  danger: "bg-danger-soft/60 border-danger/25",
};

/** White surface with hairline border and a whisper of shadow. */
export function Card({ className, interactive, flush, tone = "default", ...props }: CardProps) {
  return (
    <div
      data-flush={flush || undefined}
      className={cn(
        "group/card relative flex flex-col rounded-lg border text-ink shadow-xs",
        tones[tone],
        interactive &&
          "transition-[box-shadow,border-color,transform] duration-(--motion-base) ease-out-soft hover:border-border-hover hover:shadow-md focus-within:border-border-hover",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn("flex items-start justify-between gap-4 px-5 pt-5 pb-3", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentPropsWithRef<"h3">) {
  return <h3 className={cn("text-md font-semibold leading-6 text-ink", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentPropsWithRef<"p">) {
  return <p className={cn("mt-0.5 text-sm text-ink-muted", className)} {...props} />;
}

/** Right-hand actions in a header (buttons, menus). */
export function CardActions({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div className={cn("flex shrink-0 items-center gap-2", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn(
        "px-5 py-4 first:pt-5 last:pb-5",
        "in-data-flush:p-0 in-data-flush:first:pt-0 in-data-flush:last:pb-0",
        className,
      )}
      {...props}
    />
  );
}

export function CardFooter({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-sm text-ink-muted",
        className,
      )}
      {...props}
    />
  );
}
