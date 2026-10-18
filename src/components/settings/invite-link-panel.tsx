"use client";

import * as React from "react";
import { Link2, MailCheck, ShieldAlert } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import { formatDate } from "@/lib/dates";

export interface InviteLinkPanelProps {
  /** Who the link is for. */
  name: string;
  email?: string | null;
  inviteUrl: string;
  /** True when the server emailed the link (RESEND_API_KEY + EMAIL_FROM); false → the admin passes it on. */
  emailed: boolean;
  /** ISO timestamp the link stops working (7 days). */
  expiresAt: string;
  timeZone: string;
  /** Visible heading; defaults to "Invite link for <name>". */
  title?: React.ReactNode;
}

/**
 * The invite link, shown ONCE right after it was created or re-sent (front door): a copy box with
 * [Copy link], whether it was emailed, and when it expires. Copying never invalidates the link; only
 * "Send a new link" does, so this panel is the only place the plain link is ever shown.
 */
export function InviteLinkPanel({ name, email, inviteUrl, emailed, expiresAt, timeZone, title }: InviteLinkPanelProps) {
  return (
    <div className="flex flex-col gap-3" data-invite-link-panel="">
      <div className="rounded-lg border border-border bg-surface-sunken p-4">
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <Link2 aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 truncate">
            {title ?? (
              <>
                Invite link for <span className="font-medium text-ink">{name}</span>
              </>
            )}
          </span>
        </div>
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <code className="select-all break-all font-mono text-sm leading-5 text-ink" aria-label="Invite link" data-invite-url="">
            {inviteUrl}
          </code>
          <CopyButton value={inviteUrl} label="Copy link" successMessage="Invite link copied" variant="outline" className="shrink-0 self-start sm:self-auto" />
        </div>
        <p className="mt-2.5 text-xs text-ink-muted">
          Works until <time dateTime={expiresAt}>{formatDate(expiresAt, timeZone)}</time>. Opening it lets {name.split(" ")[0] || "them"} choose their own password.
        </p>
      </div>
      {emailed ? (
        <p className="flex items-start gap-2 text-sm text-ink-secondary" data-invite-emailed="true">
          <MailCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
          <span>
            We emailed {email ? <span className="font-medium text-ink">{email}</span> : "them"} — the link also works if you copy it.
          </span>
        </p>
      ) : (
        <p className="flex items-start gap-2 text-sm text-ink-secondary" data-invite-emailed="false">
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-attention" />
          <span>Nothing was emailed. Send {email ? <span className="font-medium text-ink">{email}</span> : "them"} this link yourself — it is shown here once.</span>
        </p>
      )}
    </div>
  );
}
