import * as React from "react";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface AccessDeniedProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Replace the default "Back to dashboard" action. */
  action?: React.ReactNode;
  /** Inline panel inside a card/section instead of a page-level block. */
  compact?: boolean;
  className?: string;
}

/**
 * Calm "you can't see this" panel for sections a role may not view (e.g.
 * team workloads for an editor). Page-level denials use `guard()` → 403.
 */
export function AccessDenied({
  title = "You don't have access to this",
  description = "Your role doesn't include this area. If you think you need it, ask an owner or manager to update your permissions.",
  action,
  compact = false,
  className,
}: AccessDeniedProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "rounded-lg border border-dashed border-border-strong bg-surface-sunken/60 px-4 py-8" : "px-6 py-16",
        className,
      )}
    >
      <div
        className={cn(
          "mb-4 flex items-center justify-center rounded-full bg-surface-muted text-ink-muted ring-1 ring-inset ring-border",
          compact ? "size-9 [&_svg]:size-4" : "size-12 [&_svg]:size-5",
        )}
      >
        <LockKeyhole aria-hidden="true" />
      </div>
      <h3 className={cn("font-semibold text-ink", compact ? "text-base" : "text-md")}>{title}</h3>
      {description ? <p className="mt-1 max-w-sm text-sm text-ink-muted">{description}</p> : null}
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {action ?? (
          <Button variant="outline" size={compact ? "sm" : "md"} href="/dashboard">
            Back to dashboard
          </Button>
        )}
      </div>
    </div>
  );
}
