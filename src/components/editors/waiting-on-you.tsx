import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { pluralise } from "@/lib/utils";

export interface WaitingOnYouProps {
  count: number;
  oldestAgeSeconds: number | null;
}

/** "oldest 2 days" / "oldest 3 hours" / "oldest 20 minutes". */
function oldestText(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `oldest ${pluralise(days, "day")}`;
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return `oldest ${pluralise(hours, "hour")}`;
  const minutes = Math.max(1, Math.floor(seconds / 60));
  return `oldest ${pluralise(minutes, "minute")}`;
}

/**
 * The top line of the Editors page (docs/SIMPLIFICATION-PLAN.md §7): your own waiting pile, shown on its
 * own line so your delay is visible and never counted against an editor.
 */
export function WaitingOnYou({ count, oldestAgeSeconds }: WaitingOnYouProps) {
  if (count === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-muted">
        <ClipboardCheck aria-hidden="true" className="size-4 text-success" />
        Waiting on you: nothing to check right now.
      </p>
    );
  }
  return (
    <Card tone="attention" className="px-4 py-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink">
        <ClipboardCheck aria-hidden="true" className="size-4 shrink-0 text-attention" />
        <span className="font-medium">Waiting on you:</span>
        <Link href="/jobs?stage=ready_to_check" className="font-medium text-attention-fg underline-offset-4 hover:underline focus-ring rounded-xs">
          {pluralise(count, "edit")} to check
        </Link>
        {oldestAgeSeconds !== null ? <span className="text-ink-secondary">({oldestText(oldestAgeSeconds)})</span> : null}
        <span className="basis-full text-xs text-ink-muted sm:basis-auto sm:text-sm">Your checking time never counts against an editor.</span>
      </p>
    </Card>
  );
}
