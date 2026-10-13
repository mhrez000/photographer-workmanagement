"use client";

import * as React from "react";
import { UserRoundPen } from "lucide-react";
import { AssignEditorDialog } from "@/components/job-simple/assign-editor-dialog";
import { useConflict } from "@/components/job-simple/use-conflict";
import { Button } from "@/components/ui/button";
import type { EditorPickerOption } from "@/lib/types";

export interface ChangeEditorButtonProps {
  jobId: string;
  version: number;
  currentEditorId: string;
  jobLabel: string;
  /** Picker rows loaded once by the page (avoids one fetch per row). */
  options: EditorPickerOption[];
  timeZone: string;
}

/** "Change editor" on one job of the editor page's "On their desk now" list. */
export function ChangeEditorButton({ jobId, version, currentEditorId, jobLabel, options, timeZone }: ChangeEditorButtonProps) {
  const [open, setOpen] = React.useState(false);
  const { onConflict, conflictDialog } = useConflict(timeZone);
  return (
    <>
      <Button variant="outline" size="sm" leadingIcon={<UserRoundPen aria-hidden="true" />} onClick={() => setOpen(true)}>
        Change editor
      </Button>
      <AssignEditorDialog open={open} onOpenChange={setOpen} jobId={jobId} version={version} mode="change" currentEditorId={currentEditorId} jobLabel={jobLabel} options={options} onConflict={onConflict} />
      {conflictDialog}
    </>
  );
}
