/**
 * Link-based quick-filter tabs with counts (Jobs page). Server-safe: each tab
 * is a plain link to `?quick=…`, so tabs are shareable and work without JS.
 */
import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export interface QuickTab {
  key: string;
  label: string;
  href: string;
  count: number | null;
  active: boolean;
  /** Draw the count in an urgency tone when non-zero. */
  tone?: "danger" | "attention" | "warning";
}

const toneClass: Record<NonNullable<QuickTab["tone"]>, string> = {
  danger: "bg-danger-soft text-danger-fg",
  attention: "bg-attention-soft text-attention-fg",
  warning: "bg-warning-soft text-warning-fg",
};

export function QuickTabs({ tabs, label, className }: { tabs: QuickTab[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={cn("-mx-4 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0", className)}>
      <ul className="flex min-w-max items-center gap-1 border-b border-border">
        {tabs.map((tab) => (
          <li key={tab.key}>
            <Link
              href={tab.href}
              scroll={false}
              aria-current={tab.active ? "page" : undefined}
              className={cn(
                "relative -mb-px inline-flex h-10 items-center gap-2 rounded-t-sm border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-(--motion-fast) focus-ring-inset",
                tab.active ? "border-accent text-ink" : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink",
              )}
            >
              {tab.label}
              {tab.count !== null ? (
                <span
                  className={cn(
                    "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-2xs font-semibold numeric",
                    tab.tone && tab.count > 0 ? toneClass[tab.tone] : tab.active ? "bg-accent-soft text-accent-ink" : "bg-surface-muted text-ink-muted",
                  )}
                >
                  {tab.count.toLocaleString("en-AU")}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
