import * as React from "react";
import { SectionCard } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { SIMPLE_CHANGES_DEFAULT_REASON } from "@/lib/constants";
import { formatDateShort, formatDateTime } from "@/lib/dates";
import type { ChangesAskedRound } from "@/lib/types";

export interface ChangesAskedSectionProps {
  rounds: ChangesAskedRound[];
  timeZone: string;
  className?: string;
}

/** Changes asked (plan §5): each round shows what was asked, by whom and when, and "Fixed and sent back" or "Open". Hidden before the first round. */
export function ChangesAskedSection({ rounds, timeZone, className }: ChangesAskedSectionProps) {
  if (rounds.length === 0) return null;
  const ordered = [...rounds].sort((a, b) => b.round - a.round);
  return (
    <SectionCard id="changes" title="Changes asked" description={`${rounds.length} ${rounds.length === 1 ? "round" : "rounds"} so far`} className={className}>
      <ol className="flex flex-col divide-y divide-border/70">
        {ordered.map((r) => {
          const chips = r.reason && r.reason !== SIMPLE_CHANGES_DEFAULT_REASON ? r.reason.split(",").map((c) => c.trim()).filter(Boolean) : [];
          return (
            <li key={r.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                <span className="font-semibold text-ink">Round {r.round}</span>
                <span>asked by {r.who.name}</span>
                <time dateTime={r.when} title={formatDateTime(r.when, timeZone)}>
                  {formatDateShort(r.when, timeZone)}
                </time>
                {r.status === "open" ? (
                  <Badge variant="danger" size="sm">
                    Open
                  </Badge>
                ) : r.status === "withdrawn" ? (
                  <Badge variant="neutral" size="sm">
                    Withdrawn
                  </Badge>
                ) : (
                  <Badge variant="success" size="sm" title={r.fixedAt ? formatDateTime(r.fixedAt, timeZone) : undefined}>
                    Fixed and sent back{r.fixedAt ? ` · ${formatDateShort(r.fixedAt, timeZone)}` : ""}
                  </Badge>
                )}
              </div>
              <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">{r.what}</p>
              {chips.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {chips.map((c) => (
                    <span key={c} className="rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-ink-secondary">
                      {c}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </SectionCard>
  );
}
