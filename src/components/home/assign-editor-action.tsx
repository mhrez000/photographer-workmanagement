"use client";

import * as React from "react";
import { UserPlus } from "lucide-react";
import { AssignEditorDialog } from "@/components/job-simple/assign-editor-dialog";
import { useConflict } from "@/components/job-simple/use-conflict";
import { Button } from "@/components/ui/button";

export interface AssignEditorActionProps {
  jobId: string;
  version: number;
  jobLabel: string;
  timeZone: string;
  className?: string;
}

/** The [Assign editor] button on a "No editor yet" row — the same picker as the job page ("On their desk 3 · Late 1"). */
export function AssignEditorAction({ jobId, version, jobLabel, timeZone, className }: AssignEditorActionProps) {
  const [open, setOpen] = React.useState(false);
  const { onConflict, conflictDialog } = useConflict(timeZone);
  return (
    <>
      <Button size="sm" variant="outline" leadingIcon={<UserPlus aria-hidden="true" />} onClick={() => setOpen(true)} className={className}>
        Assign editor
      </Button>
      <AssignEditorDialog open={open} onOpenChange={setOpen} jobId={jobId} version={version} jobLabel={jobLabel} onConflict={onConflict} />
      {conflictDialog}
    </>
  );
}
