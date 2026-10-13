"use client";

import * as React from "react";
import { FolderOpen, Play } from "lucide-react";
import { simpleJobApi } from "@/components/job-simple/api";
import { useConflict } from "@/components/job-simple/use-conflict";
import { useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import type { MyJobCard } from "@/lib/types";
import { SendForCheckingEntry } from "./send-for-checking-entry";

export interface CardActionsProps {
  card: MyJobCard;
  timeZone: string;
}

/**
 * The buttons on a My jobs card (docs/SIMPLIFICATION-PLAN.md §6): [Raw files] opens straight from the
 * card, plus ONE main button — Start editing or Send for checking. Read-only sections render nothing.
 */
export function CardActions({ card, timeZone }: CardActionsProps) {
  const run = useMutationRunner();
  const { onConflict, conflictDialog } = useConflict(timeZone);
  const [starting, setStarting] = React.useState(false);
  const { job, nextStep, hasFinishedLink } = card;

  const startEditing = async () => {
    setStarting(true);
    await run(() => simpleJobApi.startEditing(job.id, { expectedVersion: job.version }), { success: "Editing started", onConflict });
    setStarting(false);
  };

  const raw = job.rawLink ? (
    <Button variant="outline" href={job.rawLink.url} target="_blank" rel="noopener noreferrer" leadingIcon={<FolderOpen aria-hidden="true" />} className="flex-1 sm:flex-none">
      Raw files
    </Button>
  ) : null;

  let main: React.ReactNode = null;
  if (nextStep === "start_editing") {
    main = (
      <Button leadingIcon={<Play aria-hidden="true" />} onClick={startEditing} loading={starting} className="flex-1 sm:flex-none">
        Start editing
      </Button>
    );
  } else if (nextStep === "send_for_checking") {
    main = <SendForCheckingEntry job={job} hasFinishedLink={hasFinishedLink} timeZone={timeZone} />;
  }

  if (!raw && !main) return null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {raw}
        {main}
      </div>
      {conflictDialog}
    </>
  );
}
