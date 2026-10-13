import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { MyJobCard } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DUE_TONE_CLASS, dueText } from "./due-text";

export interface NextUpProps {
  name: string;
  nextUp: MyJobCard | null;
  /** Anything at all on the desk (drives the "all clear" wording). */
  hasWork: boolean;
  timeZone: string;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "Hi Sam. Next up: 8 Penrose St, due today. [Open]" (docs/SIMPLIFICATION-PLAN.md §6). */
export function NextUp({ name, nextUp, hasWork, timeZone }: NextUpProps) {
  const hi = `Hi ${firstName(name)}.`;
  if (!nextUp) {
    return (
      <Card className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-lg font-semibold leading-7 text-ink">
          {hi} <span className="font-normal text-ink-secondary">{hasWork ? "Nothing needs you right now." : "Your desk is clear."}</span>
        </p>
        <p className="flex items-center gap-1.5 text-sm text-ink-muted">
          <Sparkles aria-hidden="true" className="size-4 text-success" />
          {hasWork ? "Everything you have is waiting to be checked." : "New jobs will appear here when they are given to you."}
        </p>
      </Card>
    );
  }
  const due = dueText(nextUp.job.due, timeZone);
  const reason = nextUp.changesAsked ? "changes asked" : due.tone === "late" ? due.label.toLowerCase() : due.label.toLowerCase();
  return (
    <Card tone="accent" className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 text-lg font-semibold leading-7 text-ink">
        {hi} <span className="font-normal text-ink-secondary">Next up:</span> <span className="break-words">{nextUp.job.name}</span>
        <span className={cn("font-normal", DUE_TONE_CLASS[due.tone])}>, {reason}.</span>
      </p>
      <Button href={`/jobs/${encodeURIComponent(nextUp.job.id)}`} leadingIcon={<ArrowRight aria-hidden="true" />} className="shrink-0 self-start sm:self-auto">
        Open
      </Button>
    </Card>
  );
}
