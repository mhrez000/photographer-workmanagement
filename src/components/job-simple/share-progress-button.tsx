"use client";

import * as React from "react";
import { Eye } from "lucide-react";
import { ConfirmDialog } from "@/components/common";
import { useMutationRunner } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { useConflict } from "./use-conflict";

export interface ShareProgressButtonProps {
  jobId: string;
  version: number;
  clientName: string;
  timeZone?: string;
  className?: string;
}

/**
 * "Share progress" on the side column (plan §5 "Client can see this job"): lets a portal client follow
 * the job (Booked → Shot → Editing → Delivered) before it is finished. Finished photos still only go
 * out with Approve & send / Send to client. `POST /api/jobs/:id/share` (`job.share_with_client`).
 */
export function ShareProgressButton({ jobId, version, clientName, timeZone, className }: ShareProgressButtonProps) {
  const run = useMutationRunner();
  const { onConflict, conflictDialog } = useConflict(timeZone);
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" size="sm" leadingIcon={<Eye aria-hidden="true" />} onClick={() => setOpen(true)} className={className} data-share-progress="">
        Share progress
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Let ${clientName} follow this job?`}
        description="They see Booked → Shot → Editing → Delivered in their portal, and only the links you choose to share. The finished photos still go out when you Approve & send or Send to client."
        confirmLabel="Share progress"
        onConfirm={async () => {
          const result = await run(() => api.post(`/api/jobs/${encodeURIComponent(jobId)}/share`, { shared: true, expectedVersion: version }), {
            success: "Shared",
            successDescription: `${clientName} can now follow this job in their portal.`,
            onConflict: (err) => {
              setOpen(false);
              onConflict(err);
            },
          });
          return result.ok ? undefined : false;
        }}
      />
      {conflictDialog}
    </>
  );
}
