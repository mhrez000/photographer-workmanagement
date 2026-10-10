"use client";

import * as React from "react";
import { Camera } from "lucide-react";
import { VIEW_SCOPE_LABELS, type ViewScope } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useScopeSwitch } from "./scope-switch";

export interface ScopeNoticeProps {
  /** The page's resolved scope (null = the viewer has no scope switch: renders nothing). */
  scope: ViewScope | null;
  className?: string;
}

/**
 * Page-header hint for the personal view (docs/ROLES.md §8: "Page headers show
 * the active scope with a one-click switch back"). Renders only in "My shoots".
 */
export function ScopeNotice({ scope, className }: ScopeNoticeProps) {
  if (scope !== "mine") return null;
  return <ScopeNoticeInner className={className} />;
}

function ScopeNoticeInner({ className }: { className?: string }) {
  const { change, pending } = useScopeSwitch("mine");
  return (
    <span
      data-scope-notice=""
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-ink-muted",
        pending && "opacity-70",
        className,
      )}
    >
      <Camera aria-hidden="true" className="size-3.5 text-ink-subtle" />
      <span>
        Showing: <span className="font-medium text-ink">{VIEW_SCOPE_LABELS.mine}</span>
      </span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        onClick={() => void change("business")}
        disabled={pending}
        className="rounded-xs font-medium text-accent-ink hover:underline focus-ring disabled:opacity-60"
      >
        Show {VIEW_SCOPE_LABELS.business.toLowerCase()}
      </button>
    </span>
  );
}
