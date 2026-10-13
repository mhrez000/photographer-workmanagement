import * as React from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SectionCard } from "@/components/common";
import { formatDateShort, formatDateTime } from "@/lib/dates";
import type { WhoDidWhatEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface WhoDidWhatProps {
  jobId: string;
  entries: WhoDidWhatEntry[];
  timeZone: string;
  className?: string;
}

function sentence(e: WhoDidWhatEntry): { text: string; tone?: "success" | "danger" } {
  const by = e.actor ? ` by ${e.actor.name}` : "";
  switch (e.kind) {
    case "created":
      return { text: `Created${by}` };
    case "given_to":
      return { text: `Given to ${e.subject?.name ?? "an editor"}${by}` };
    case "moved_to":
      return { text: `Moved to ${e.subject?.name ?? "another editor"}${by}` };
    case "taken_back":
      // The editor removing themselves is "Can't do this one", not a take-back.
      if (e.actor && e.subject && e.actor.id === e.subject.id) return { text: `Handed back by ${e.actor.name} (can't do this one)` };
      return { text: `Taken back from ${e.subject?.name ?? "the editor"}${by}` };
    case "started":
      return { text: `Started editing${by}` };
    case "sent_for_checking":
      return e.onTime === null ? { text: `Sent for checking${by}` } : e.onTime ? { text: `Sent for checking${by} (on time)`, tone: "success" } : { text: `Sent for checking${by} (late)`, tone: "danger" };
    case "sent_back":
      return { text: `Sent back for checking${by}` };
    case "changes_asked":
      return { text: `Changes asked${e.round ? ` (round ${e.round})` : ""}${by}`, tone: "danger" };
    case "approved":
      return { text: `Approved${by}`, tone: "success" };
    case "sent_to_client":
      return { text: `Sent to client${by}`, tone: "success" };
    case "closed":
      return { text: `Closed${by}` };
    case "cancelled":
      return { text: `Cancelled${by}`, tone: "danger" };
    case "restored":
      return { text: `Restored${by}` };
    case "reopened":
      return { text: `Reopened${by}` };
  }
}

/** Who did what (plan §5): a short dated list; "Full history" opens the complete, permanent audit log. */
export function WhoDidWhat({ jobId, entries, timeZone, className }: WhoDidWhatProps) {
  return (
    <SectionCard
      id="who-did-what"
      title="Who did what"
      className={className}
      footer={
        <Link href={`/jobs/${jobId}/history`} className="inline-flex items-center gap-1 font-medium text-ink-secondary hover:text-ink focus-ring rounded-xs">
          Full history
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      }
    >
      {entries.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing recorded yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {entries.map((e, i) => {
            const s = sentence(e);
            return (
              <li key={`${e.kind}-${e.at}-${i}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 text-sm">
                <time dateTime={e.at} title={formatDateTime(e.at, timeZone)} className="text-ink-muted numeric">
                  {formatDateShort(e.at, timeZone)}
                </time>
                <span className={cn("text-ink", s.tone === "success" && "text-success-fg", s.tone === "danger" && "text-danger-fg")}>{s.text}</span>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}
