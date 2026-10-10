"use client";

import * as React from "react";
import Link from "next/link";
import { Eye, EyeOff, Globe, Lock, MessageSquareText } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { useMutationRunner } from "@/components/jobs/mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import type { JobClientAccess } from "@/lib/sharing";
import { ClientFeedbackThreads } from "./client-feedback-threads";
import { DeliveryNotesEditor } from "./delivery-notes-editor";
import { SharedLinksList } from "./shared-links-list";

export interface ClientAccessCardProps {
  access: JobClientAccess;
  timeZone: string;
  /** Server-rendered "What the client sees" preview (PortalJobView in preview mode). */
  preview?: React.ReactNode;
}

function StatusLine({ access }: { access: JobClientAccess }) {
  const { client } = access;
  if (client.archived) return <Badge variant="outline">Client archived — portal closed</Badge>;
  if (!client.portalEnabled) {
    return (
      <Badge variant="neutral" title={`${client.name} has no portal access`}>
        <Lock aria-hidden="true" />
        Portal off
      </Badge>
    );
  }
  if (access.visibleToClient) {
    return (
      <Badge variant="success" dot title={`Visible to ${client.name} in their portal`}>
        Visible to client
      </Badge>
    );
  }
  return (
    <Badge variant="neutral">
      <EyeOff aria-hidden="true" />
      Not shared
    </Badge>
  );
}

/**
 * Job detail "Client access" card (docs/ROLES.md §7.1–§7.5, §11): share the
 * job, choose which links the client sees, delivery notes, client feedback
 * threads with replies, and a "What the client sees" preview. Every switch is
 * disabled unless the viewer holds the matching permission; the server
 * re-checks each change.
 */
export function ClientAccessCard({ access, timeZone, preview }: ClientAccessCardProps) {
  const run = useMutationRunner();
  const [pending, setPending] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const { client, project } = access;
  const waiting = access.feedback.filter((t) => t.waiting && !t.fromOtherClient).length;

  async function toggleJob(shared: boolean) {
    setPending(true);
    await run(() => api.post(`/api/jobs/${access.jobId}/share`, { shared, expectedVersion: access.jobVersion }), {
      success: shared ? `Shared with ${client.name}` : `No longer shared with ${client.name}`,
      successDescription: shared && !client.portalEnabled ? "Turn on their portal so they can sign in." : undefined,
    });
    setPending(false);
  }

  return (
    <SectionCard
      id="client-access"
      title="Client access"
      description={`What ${client.name} can see in their portal.`}
      actions={<StatusLine access={access} />}
      footer={
        preview ? (
          <Button type="button" size="sm" variant="ghost" className="-ml-2" leadingIcon={<Eye aria-hidden="true" />} onClick={() => setPreviewOpen(true)}>
            What the client sees
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Switch
            checked={access.sharedWithClient}
            disabled={!access.can.shareJob || pending}
            onCheckedChange={(v) => void toggleJob(v)}
            label={`Share this job with ${client.name}`}
            description={
              project.sharedWithClient
                ? `Already shared through project ${project.name}. Sharing the job too keeps it visible if the project is unshared.`
                : "The client sees the job name, project, milestones and agreed dates — never internal notes, editors or comments."
            }
          />
          {!access.can.shareJob ? <p className="text-xs text-ink-muted">Only someone who reviews this job can change what the client sees.</p> : null}
          {!client.portalEnabled && !client.archived ? (
            <p className="flex flex-wrap items-center gap-1.5 rounded-md bg-surface-sunken px-3 py-2 text-sm text-ink-secondary">
              <Globe aria-hidden="true" className="size-4 text-ink-subtle" />
              {client.name} can&apos;t sign in yet.
              {access.can.managePortal ? (
                <Link href={`/clients/${client.id}#client-portal`} className="font-medium text-accent-ink hover:underline">
                  Turn on their portal
                </Link>
              ) : (
                <span>Ask an admin to turn on their portal.</span>
              )}
            </p>
          ) : client.portalEnabled && client.activePortalUsers === 0 && access.can.managePortal ? (
            <p className="text-sm text-ink-muted">
              No portal users yet.{" "}
              <Link href={`/clients/${client.id}#client-portal`} className="font-medium text-accent-ink hover:underline">
                Invite someone from {client.name}
              </Link>
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink">Links the client can open</h3>
          <SharedLinksList links={access.links} clientName={client.name} />
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink">Delivery notes</h3>
          <DeliveryNotesEditor jobId={access.jobId} clientName={client.name} notes={access.deliveryNotes} canAdd={access.can.addDeliveryNote} timeZone={timeZone} />
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <MessageSquareText aria-hidden="true" className="size-4 text-ink-subtle" />
            Client feedback
            {waiting > 0 ? (
              <Badge size="sm" variant="attention">
                {waiting} waiting
              </Badge>
            ) : null}
          </h3>
          {!client.feedbackEnabled && access.feedback.length === 0 ? (
            <p className="text-sm text-ink-muted">Feedback is off for {client.name}.</p>
          ) : (
            <ClientFeedbackThreads
              jobId={access.jobId}
              jobNumber={access.jobNumber}
              jobVersion={access.jobVersion}
              editor={access.editor}
              clientName={client.name}
              threads={access.feedback}
              canReply={access.can.reply}
              canTurnIntoRevision={access.can.turnIntoRevision}
              timeZone={timeZone}
            />
          )}
        </div>
      </div>

      {preview ? (
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen} size="xl">
          <DialogHeader>
            <DialogTitle>What {client.name} sees</DialogTitle>
            <DialogDescription>
              {access.visibleToClient && client.portalEnabled
                ? "This is the job exactly as it appears in their portal."
                : "Not visible to them yet — this is how it will look once shared and their portal is on."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="bg-canvas pb-6">{preview}</DialogBody>
        </Dialog>
      ) : null}
    </SectionCard>
  );
}
