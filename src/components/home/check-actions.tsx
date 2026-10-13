"use client";

import * as React from "react";
import { Images, MessageSquareText } from "lucide-react";
import { ApproveButton } from "@/components/job-simple/approve-button";
import { AskForChangesDialog } from "@/components/job-simple/ask-for-changes-dialog";
import { useConflict } from "@/components/job-simple/use-conflict";
import { Button } from "@/components/ui/button";
import type { ReadyToCheckCard } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface CheckActionsProps {
  card: ReadyToCheckCard;
  timeZone: string;
  className?: string;
}

/**
 * The Ready-to-check buttons on Home (docs/SIMPLIFICATION-PLAN.md §6):
 * [Open finished photos] [Approve] [Ask for changes] — the SAME Approve (with the
 * "Approve & send / Approve only" question, §12.2, and the "You edited this yourself" check,
 * §12.3) and the same Ask-for-changes box as the job page. A photographer who does not check
 * their own edits sees "<owner> will check this" instead (§12.4). 409 → ConflictDialog.
 */
export function CheckActions({ card, timeZone, className }: CheckActionsProps) {
  const [asking, setAsking] = React.useState(false);
  const { onConflict, conflictDialog } = useConflict(timeZone);
  const job = card.job;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {card.finishedLink ? (
        <Button variant="outline" size="sm" href={card.finishedLink.url} target="_blank" rel="noopener noreferrer" leadingIcon={<Images aria-hidden="true" />}>
          Open finished photos
        </Button>
      ) : null}
      {card.canCheck ? (
        <>
          <ApproveButton
            size="sm"
            jobId={job.id}
            version={job.version}
            clientName={job.client.name}
            shareQuestion={card.shareQuestion}
            selfReviewNeedsConfirm={card.selfReviewNeedsConfirm}
            shareableLinks={card.finishedLink ? [card.finishedLink] : []}
            finishedLink={card.finishedLink}
            onConflict={onConflict}
          />
          <Button variant="outline" size="sm" leadingIcon={<MessageSquareText aria-hidden="true" />} onClick={() => setAsking(true)}>
            Ask for changes
          </Button>
          <AskForChangesDialog
            open={asking}
            onOpenChange={setAsking}
            jobId={job.id}
            version={job.version}
            editorName={job.editor?.name ?? null}
            jobLabel={job.name}
            timeZone={timeZone}
            onConflict={onConflict}
          />
          {conflictDialog}
        </>
      ) : (
        <span className="text-sm text-ink-muted">{card.checkedBy ?? "The owner"} will check this</span>
      )}
    </div>
  );
}
