"use client";

import * as React from "react";
import { ArrowRightLeft, ExternalLink } from "lucide-react";
import { AssignEditorDialog, ConflictDialog, jobHref } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import type { ApiError } from "@/lib/api-client";
import type { UserRef } from "@/lib/types";

export interface BottleneckJobActionsProps {
  job: { id: string; jobNumber: string; name: string; version: number; editor: UserRef | null };
  canReassign: boolean;
  timeZone: string;
}

/** Quick actions on an affected job: open it, or (re)assign the editor in place. */
export function BottleneckJobActions({ job, canReassign, timeZone }: BottleneckJobActionsProps) {
  const [assigning, setAssigning] = React.useState(false);
  const [conflict, setConflict] = React.useState<ApiError | null>(null);
  return (
    <div className="flex shrink-0 items-center gap-1">
      {canReassign ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAssigning(true)}
          leadingIcon={<ArrowRightLeft aria-hidden="true" />}
          aria-label={`${job.editor ? "Reassign" : "Assign"} ${job.jobNumber}`}
        >
          {job.editor ? "Reassign" : "Assign"}
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" href={jobHref(job.id)} leadingIcon={<ExternalLink aria-hidden="true" />} aria-label={`Open ${job.jobNumber}`}>
        Open
      </Button>
      {assigning ? (
        <AssignEditorDialog
          open
          onOpenChange={setAssigning}
          jobId={job.id}
          version={job.version}
          current={job.editor}
          jobLabel={`${job.jobNumber} · ${job.name}`}
          onConflict={setConflict}
        />
      ) : null}
      <ConflictDialog open={conflict !== null} onOpenChange={(o) => !o && setConflict(null)} error={conflict} entity="job" timeZone={timeZone} />
    </div>
  );
}
