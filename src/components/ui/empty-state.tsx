import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps extends Omit<React.ComponentPropsWithRef<"div">, "title"> {
  /** Lucide icon component or any node. */
  icon?: LucideIcon | React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary / secondary actions (Buttons). */
  action?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  /** Dashed outline treatment for in-card placements. */
  bordered?: boolean;
}

function isLucideIcon(value: unknown): value is LucideIcon {
  return typeof value === "object" && value !== null && "$$typeof" in value && "render" in value;
}

/** Friendly "nothing here yet" panel with an optional call to action. */
export function EmptyState({
  icon = Inbox,
  title,
  description,
  action,
  size = "md",
  bordered = false,
  className,
  ...props
}: EmptyStateProps) {
  const pad = { sm: "py-8 px-4", md: "py-14 px-6", lg: "py-20 px-8" }[size];
  const iconSize = { sm: "size-9 [&_svg]:size-4", md: "size-11 [&_svg]:size-5", lg: "size-14 [&_svg]:size-6" }[size];

  let iconNode: React.ReactNode = null;
  if (isLucideIcon(icon)) {
    const Icon = icon;
    iconNode = <Icon aria-hidden="true" />;
  } else {
    iconNode = icon;
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        bordered && "rounded-lg border border-dashed border-border-strong bg-surface-sunken/60",
        pad,
        className,
      )}
      {...props}
    >
      {iconNode ? (
        <div
          className={cn(
            "mb-4 flex items-center justify-center rounded-full bg-surface-muted text-ink-muted ring-1 ring-inset ring-border",
            iconSize,
          )}
        >
          {iconNode}
        </div>
      ) : null}
      <h3 className={cn("font-semibold text-ink", size === "sm" ? "text-base" : "text-md")}>{title}</h3>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-ink-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
