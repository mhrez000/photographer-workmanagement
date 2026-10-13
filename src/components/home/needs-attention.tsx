import Link from "next/link";
import { ArrowRight, CircleCheckBig, MessageCircleQuestion, MessageSquare, Siren, UserPlus } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { relativeCivil } from "@/components/jobs-list/format";
import type { NeedsAttentionReason, NeedsAttentionRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AssignEditorAction } from "./assign-editor-action";

export interface NeedsAttentionSectionProps {
  rows: NeedsAttentionRow[];
  /** Late / no-editor jobs left off because the list is capped. */
  more?: number;
  /** Every late job the viewer can see (the "See all N late in Jobs" link). */
  lateTotal?: number;
  /** Today's civil date in the organisation timezone. */
  today: string;
  timeZone: string;
  /** The viewer may assign editors (the [Assign editor] button). */
  canAssign: boolean;
}

type Tone = "danger" | "attention" | "info";

/** The plain words for one reason. "with <name>" only when the job is really with an editor. */
function reasonWords(reason: NeedsAttentionReason, today: string): { text: string; tone: Tone; icon: typeof Siren } {
  switch (reason.kind) {
    case "late":
      return {
        text: `${reason.daysLate} ${reason.daysLate === 1 ? "day" : "days"} late${reason.withName ? ` · with ${reason.withName}` : ""}`,
        tone: "danger",
        icon: Siren,
      };
    case "no_editor":
      return {
        text: `No editor yet${reason.shotCivilDate ? ` · shot ${relativeCivil(reason.shotCivilDate, today).toLowerCase()}` : ""}`,
        tone: "attention",
        icon: UserPlus,
      };
    case "question":
      return { text: `Question from ${reason.from.name}`, tone: "info", icon: MessageCircleQuestion };
    case "client_message":
      return { text: "Message from the client", tone: "info", icon: MessageSquare };
  }
}

const TONE_RANK: Record<Tone, number> = { danger: 0, attention: 1, info: 2 };

const TONE = {
  danger: "bg-danger-soft text-danger",
  attention: "bg-attention-soft text-attention",
  info: "bg-info-soft text-info-fg",
} as const;

/**
 * "Needs attention" — one list, ONE ROW PER JOB, each with its plain reasons merged
 * ("No editor yet · 1 day late") and the [Assign editor] button where it applies
 * (docs/SIMPLIFICATION-PLAN.md §6). Capped: the footer says how many more late jobs sit in Jobs.
 * Empty: "Nothing needs you right now."
 */
export function NeedsAttentionSection({ rows, more = 0, lateTotal = 0, today, timeZone, canAssign }: NeedsAttentionSectionProps) {
  return (
    <SectionCard
      id="needs-attention"
      title="Needs attention"
      flush
      footer={
        more > 0 ? (
          <Link href="/jobs?late=1" className="inline-flex items-center gap-1 font-medium text-ink-secondary hover:text-ink focus-ring rounded-xs">
            {more} more · See all {lateTotal > 0 ? `${lateTotal} ` : ""}late in Jobs
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <div className="flex items-center gap-3 px-5 py-6 text-sm text-ink-secondary">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
            <CircleCheckBig aria-hidden="true" className="size-4" />
          </span>
          Nothing needs you right now.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => {
            const reasons = [row.reason, ...row.also].map((r) => reasonWords(r, today));
            const lead = reasons[0];
            const Icon = lead.icon;
            const tone = reasons.reduce<Tone>((t, r) => (TONE_RANK[r.tone] < TONE_RANK[t] ? r.tone : t), lead.tone);
            const excerpts = [row.reason, ...row.also].flatMap((r) => (r.kind === "question" || r.kind === "client_message" ? [r.excerpt] : []));
            return (
              <li key={row.job.id} data-needs-attention-row={row.job.id} className="flex items-start gap-3 px-5 py-3">
                <span className={cn("mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full", TONE[tone])}>
                  <Icon aria-hidden="true" className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <Link href={`/jobs/${row.job.id}`} className="break-words font-medium text-ink underline-offset-2 hover:underline focus-ring rounded-xs">
                      {row.job.name}
                    </Link>
                    <span className="text-sm text-ink-muted">{row.job.client.name}</span>
                  </p>
                  <p className={cn("text-sm", tone === "danger" ? "font-medium text-danger-fg" : "text-ink-secondary")}>{reasons.map((r) => r.text).join(" · ")}</p>
                  {excerpts.map((excerpt, i) => (
                    <p key={i} className="mt-1 line-clamp-2 text-sm text-ink-muted">
                      “{excerpt}”
                    </p>
                  ))}
                </div>
                {row.reason.kind === "no_editor" && canAssign ? (
                  <AssignEditorAction jobId={row.job.id} version={row.job.version} jobLabel={row.job.name} timeZone={timeZone} className="shrink-0" />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
