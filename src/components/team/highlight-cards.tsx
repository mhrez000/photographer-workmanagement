import * as React from "react";
import Link from "next/link";
import { Award, LifeBuoy, Sparkles, Timer } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { Highlight } from "./performance-insights";

const ICON = { on_time: Award, turnaround: Timer, first_pass: Sparkles, support: LifeBuoy } as const;

/** "Who is performing well / who needs support" callouts above the tables. */
export function HighlightCards({ highlights }: { highlights: Highlight[] }) {
  if (highlights.length === 0) return null;
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Highlights">
      {highlights.map((h) => {
        const Icon = ICON[h.kind];
        const support = h.kind === "support";
        return (
          <li key={h.kind}>
            <Link
              href={`/team/users/${h.user.id}`}
              className={cn(
                "group flex h-full items-start gap-3 rounded-lg border bg-surface p-4 shadow-xs focus-ring transition-[border-color,box-shadow] duration-(--motion-fast) hover:shadow-md",
                support ? "border-attention/30 hover:border-attention/50" : "border-border hover:border-border-hover",
              )}
            >
              <span
                className={cn(
                  "inline-flex size-8 shrink-0 items-center justify-center rounded-md",
                  support ? "bg-attention-soft text-attention" : "bg-accent-soft text-accent-ink",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="eyebrow block">{h.title}</span>
                <span className="mt-1 flex items-center gap-2">
                  <Avatar name={h.user.name} colour={h.user.avatarColour || undefined} size="xs" />
                  <span className="truncate text-md font-semibold text-ink group-hover:text-accent-ink">{h.user.name}</span>
                </span>
                <span className="mt-1 block text-sm text-ink-muted">{h.detail}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
