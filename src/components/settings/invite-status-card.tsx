"use client";

import * as React from "react";
import { Ban, MailQuestion, Send } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SectionCard } from "@/components/common/section-card";
import { useMutationRunner } from "@/components/jobs/mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/dates";
import { InviteLinkPanel } from "./invite-link-panel";

/** `POST /api/users/:id/invite/resend` */
interface ResendResult {
  inviteUrl: string;
  emailed: boolean;
  expiresAt: string;
}

export interface PendingInvite {
  /** When the live link stops working. */
  expiresAt: string;
}

export interface InviteStatusCardProps {
  userId: string;
  name: string;
  email: string;
  /** The live link (from `pendingInviteFor`), or null when every link expired or was revoked. */
  pending: PendingInvite | null;
  /** `user.invite` on this person. */
  canInvite: boolean;
  timeZone: string;
}

/**
 * A person who has not accepted their invite yet (person page, front door). The plain link is never
 * stored, so there is no [Copy link] here until the admin asks for a NEW one: [Send a new link]
 * (POST resend → the older links stop working, the fresh link shows once with Copy link) and
 * [Revoke invite] (POST revoke → no way in until a new link is sent). Copying never invalidates anything.
 */
export function InviteStatusCard({ userId, name, email, pending, canInvite, timeZone }: InviteStatusCardProps) {
  const run = useMutationRunner();
  const [fresh, setFresh] = React.useState<ResendResult | null>(null);
  const [resendOpen, setResendOpen] = React.useState(false);
  const [revokeOpen, setRevokeOpen] = React.useState(false);
  const live = fresh ? { expiresAt: fresh.expiresAt } : pending;

  const resend = async () => {
    const res = await run(() => api.post<ResendResult>(`/api/users/${userId}/invite/resend`, {}), { success: `New invite link for ${name}` });
    if (res.ok) setFresh(res.data);
    return res.ok || res.handled;
  };

  const revoke = async () => {
    const res = await run(() => api.post<{ userId: string; revoked: number }>(`/api/users/${userId}/invite/revoke`, {}), { success: `${name}'s invite link no longer works` });
    if (res.ok) setFresh(null);
    return res.ok || res.handled;
  };

  return (
    <SectionCard
      id="invite"
      title="Invite"
      description={live ? "They have not opened their link yet. Nothing else on this page works for them until they do." : "Their invite link no longer works. Send a new one when they are ready."}
      tone="attention"
      actions={
        live ? (
          <Badge variant="warning" dot data-invite-pending="live">
            Invite pending · expires {formatDate(live.expiresAt, timeZone)}
          </Badge>
        ) : (
          <Badge variant="neutral" data-invite-pending="stale">
            Invite pending · needs a new link
          </Badge>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {fresh ? (
          <InviteLinkPanel name={name} email={email} inviteUrl={fresh.inviteUrl} emailed={fresh.emailed} expiresAt={fresh.expiresAt} timeZone={timeZone} />
        ) : (
          <p className="flex items-start gap-2 text-sm text-ink-secondary">
            <MailQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
            <span>
              {live
                ? `The link was shown once when it was created${canInvite ? "; if it is lost, send a new one — the old one stops working" : ""}.`
                : canInvite
                  ? "Sending a new link is the only way back in for them."
                  : "Only an owner can send a new link."}
            </span>
          </p>
        )}
        {canInvite ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={fresh ? "outline" : "primary"} leadingIcon={<Send aria-hidden="true" />} onClick={() => setResendOpen(true)}>
              {fresh ? "Send another link" : "Send a new link"}
            </Button>
            {live ? (
              <Button size="sm" variant="outline" leadingIcon={<Ban aria-hidden="true" />} onClick={() => setRevokeOpen(true)}>
                Revoke invite
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={resendOpen}
        onOpenChange={setResendOpen}
        title={`Send ${name} a new invite link?`}
        description={live ? "Their current link stops working the moment the new one is made. You can copy the new link here, and it is emailed when your studio has email set up." : "You can copy the new link here, and it is emailed when your studio has email set up. It works for 7 days."}
        confirmLabel="Send a new link"
        onConfirm={resend}
      />
      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title={`Revoke ${name}'s invite?`}
        description="Their link stops working and they have no way in. The account stays, so you can send a new link later or deactivate them."
        confirmLabel="Revoke invite"
        destructive
        onConfirm={revoke}
      />
    </SectionCard>
  );
}
