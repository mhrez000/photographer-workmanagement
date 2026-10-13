"use client";

import * as React from "react";
import { Send } from "lucide-react";
import { SendForCheckingDialog } from "@/components/job-simple/send-for-checking";
import { useConflict } from "@/components/job-simple/use-conflict";
import { Button } from "@/components/ui/button";
import type { SimpleJobRow } from "@/lib/types";

export interface SendForCheckingEntryProps {
  job: SimpleJobRow;
  /** A finished link is already on the job: the dialog offers "I updated the same link". */
  hasFinishedLink: boolean;
  timeZone: string;
}

/**
 * The card's one main button after editing (docs/SIMPLIFICATION-PLAN.md §6): opens the job page's own
 * "Finished photos link" box in a dialog, so sending from the card is the same recorded action as on
 * the job page (the link is required, plan §9).
 */
export function SendForCheckingEntry({ job, hasFinishedLink, timeZone }: SendForCheckingEntryProps) {
  const [open, setOpen] = React.useState(false);
  const { onConflict, conflictDialog } = useConflict(timeZone);
  return (
    <>
      <Button leadingIcon={<Send aria-hidden="true" />} onClick={() => setOpen(true)} className="flex-1 sm:flex-none">
        Send for checking
      </Button>
      <SendForCheckingDialog
        open={open}
        onOpenChange={setOpen}
        jobId={job.id}
        version={job.version}
        lastLink={job.finishedLink}
        hasCurrentLink={hasFinishedLink}
        checkerName={job.photographer?.name ?? null}
        jobLabel={`${job.name} · ${job.client.name}`}
        onConflict={onConflict}
      />
      {conflictDialog}
    </>
  );
}
