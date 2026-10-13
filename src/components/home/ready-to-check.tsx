import Link from "next/link";
import { ArrowRight, ClipboardCheck } from "lucide-react";
import { RoundBadge, RushBadge } from "@/components/jobs/stage-pill";
import { sentWords } from "@/components/jobs-list/format";
import { SectionCard } from "@/components/common/section-card";
import { EmptyState } from "@/components/ui/empty-state";
import type { ReadyToCheckCard } from "@/lib/types";
import { CheckActions } from "./check-actions";

export interface ReadyToCheckSectionProps {
  cards: ReadyToCheckCard[];
  total: number;
  asOf: string;
  timeZone: string;
}

/**
 * "Ready to check (3)" — oldest first; address, client, "Edited by Sam · sent 5 h ago", Round 2,
 * and the three buttons. Footer: "See all 3 in Jobs", or, once the list is capped, "Showing the 20
 * oldest · 29 more in Jobs" so the newest send is never silently missing (docs/SIMPLIFICATION-PLAN.md §6).
 */
export function ReadyToCheckSection({ cards, total, asOf, timeZone }: ReadyToCheckSectionProps) {
  return (
    <SectionCard
      id="ready-to-check"
      title={
        <span className="inline-flex items-center gap-2">
          Ready to check
          <span className="numeric inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-stage-amber-soft px-2 text-sm font-semibold text-stage-amber-fg">{total}</span>
        </span>
      }
      description={total > 0 ? "Your turn. Oldest first." : undefined}
      flush
      footer={
        total > 0 ? (
          <Link href="/jobs?stage=ready_to_check" className="inline-flex items-center gap-1 font-medium text-ink-secondary hover:text-ink focus-ring rounded-xs">
            {cards.length < total ? `Showing the ${cards.length} oldest · ${total - cards.length} more in Jobs` : `See all ${total} in Jobs`}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        ) : undefined
      }
    >
      {cards.length === 0 ? (
        <EmptyState size="sm" icon={ClipboardCheck} title="Nothing to check" description="When an editor sends finished photos, they land here." />
      ) : (
        <ol className="divide-y divide-border">
          {cards.map((card) => {
            const job = card.job;
            return (
              <li key={job.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/jobs/${job.id}`} className="break-words text-base font-semibold text-ink underline-offset-2 hover:underline focus-ring rounded-xs">
                      {job.name}
                    </Link>
                    <RoundBadge round={card.round} />
                    <RushBadge rush={job.rush} />
                  </div>
                  <p className="mt-0.5 text-sm text-ink-secondary">
                    {job.client.name}
                    <span className="text-ink-muted">
                      {" · "}
                      {job.editor ? `Edited by ${job.editor.name}` : "Edited"} · {sentWords(card.sentAt, asOf)}
                    </span>
                  </p>
                </div>
                <CheckActions card={card} timeZone={timeZone} className="shrink-0" />
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}
