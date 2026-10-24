"use client";

import * as React from "react";
import { Link2, MailCheck, MailWarning, ShieldAlert } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import { formatDate } from "@/lib/dates";
import type { AccountEmailNotSentReason } from "@/server/email/account";

/** Why the invite was not emailed, as the API says it (`notSentReason` of POST /api/users and …/invite/resend). */
export type InviteNotSentReason = AccountEmailNotSentReason;

/** The inviter's own email is not confirmed yet, so nothing goes out on their behalf (accounts anti-abuse rule). */
export const UNCONFIRMED_SENDER_MESSAGE =
  "Your invite wasn’t emailed because your own email isn’t confirmed yet. Copy the link below and send it yourself, or confirm your email first.";

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
  /**
   * Why it was not emailed (null / absent when it was, or when the caller does not know). "unconfirmed_sender" says
   * so plainly above the link; "failed" says the email did not go through; anything else keeps the generic line.
   */
  notSentReason?: InviteNotSentReason | null;
}

/**
 * The invite link, shown ONCE right after it was created or re-sent (front door): a copy box with
 * [Copy link], whether it was emailed, and when it expires. Copying never invalidates the link; only
 * "Send a new link" does, so this panel is the only place the plain link is ever shown.
 */
export function InviteLinkPanel({ name, email, inviteUrl, emailed, expiresAt, timeZone, title, notSentReason = null }: InviteLinkPanelProps) {
  const unconfirmedSender = !emailed && notSentReason === "unconfirmed_sender";
  const who = email ? <span className="font-medium text-ink">{email}</span> : "them";
  return (
    <div className="flex flex-col gap-3" data-invite-link-panel="">
      {unconfirmedSender ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-attention/30 bg-attention-soft px-3 py-2 text-sm text-ink"
          data-invite-emailed="false"
          data-invite-not-sent-reason="unconfirmed_sender"
        >
          <MailWarning aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-attention" />
          <span>{UNCONFIRMED_SENDER_MESSAGE}</span>
        </p>
      ) : null}
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
          <span>We emailed {who} — the link also works if you copy it.</span>
        </p>
      ) : unconfirmedSender ? (
        <p className="flex items-start gap-2 text-sm text-ink-secondary">
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-attention" />
          <span>The link is shown here once — copy it before you close this.</span>
        </p>
      ) : (
        <p className="flex items-start gap-2 text-sm text-ink-secondary" data-invite-emailed="false" data-invite-not-sent-reason={notSentReason ?? undefined}>
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-attention" />
          <span>
            {notSentReason === "failed" ? "The email didn’t go through, so nothing was sent." : "Nothing was emailed."} Send {who} this link yourself — it is shown
            here once.
          </span>
        </p>
      )}
    </div>
  );
}
