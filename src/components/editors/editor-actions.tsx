"use client";

import * as React from "react";
import { ArrowRightLeft, Plus, UserRoundCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { EditorPickerOption, UserRef } from "@/lib/types";
import { MoveJobsDialog } from "./move-jobs-dialog";

export interface EditorActionsProps {
  editor: UserRef;
  /** Jobs on their desk (what "Move their jobs to…" moves). */
  onDesk: ReadonlyArray<{ id: string; version: number; name: string }>;
  options: EditorPickerOption[];
  /** The viewer may assign editors (owners / co-owners; members with the switch). */
  canAssign: boolean;
  /** The viewer manages people (owners / co-owners). */
  canEditPerson: boolean;
  canCreateJobs: boolean;
}

/** [Give them a job] [Move their jobs to…] [Edit person] (docs/SIMPLIFICATION-PLAN.md §7). */
export function EditorActions({ editor, onDesk, options, canAssign, canEditPerson, canCreateJobs }: EditorActionsProps) {
  const [moveOpen, setMoveOpen] = React.useState(false);
  const id = encodeURIComponent(editor.id);
  return (
    <>
      {canCreateJobs && editor.isActive ? (
        <Button href={`/jobs/new?editorId=${id}`} leadingIcon={<Plus aria-hidden="true" />}>
          Give them a job
        </Button>
      ) : null}
      {canAssign ? (
        <Button variant="outline" leadingIcon={<ArrowRightLeft aria-hidden="true" />} onClick={() => setMoveOpen(true)} disabled={onDesk.length === 0} title={onDesk.length === 0 ? "Nothing on their desk to move" : undefined}>
          Move their jobs to…
        </Button>
      ) : null}
      {canEditPerson ? (
        <Button variant="outline" href={`/settings/people/${id}`} leadingIcon={<UserRoundCog aria-hidden="true" />}>
          Edit person
        </Button>
      ) : null}
      <MoveJobsDialog open={moveOpen} onOpenChange={setMoveOpen} from={editor} jobs={onDesk} options={options} />
    </>
  );
}
