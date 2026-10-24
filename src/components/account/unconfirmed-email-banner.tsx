"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Mail, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toastResendOutcome, useResendEmailConfirmation } from "./resend-email-confirmation";

export interface UnconfirmedEmailBannerProps {
  /** The address waiting to be confirmed. */
  email: string;
  /** Where "Change email" goes (`/settings/account#email` or `/portal/account#email`). */
  accountHref: string;
}

/**
 * "Please confirm your email. We sent a link to x. [Send again] [Change email]" — a quiet strip above the page
 * (AREA verify, docs/ACCOUNTS-PLAN.md §4). Rendered by `AccountBanners` only when email is configured, the studio is
 * not the demo, and the address is unconfirmed (`accountBannerState`). [Send again] asks for a fresh link
 * (POST /api/auth/email-verification/resend; 5 an hour → "Try again in N minutes"); [Change email] opens the Email
 * card of My account (the address may simply be wrong). Not an alarm: everything keeps working meanwhile.
 */
export function UnconfirmedEmailBanner({ email, accountHref }: UnconfirmedEmailBannerProps) {
  const router = useRouter();
  const { pending, send } = useResendEmailConfirmation();
  // Line the text up with the page below it: the portal's column is narrower than the staff shell's.
  const portal = accountHref.startsWith("/portal");

  const sendAgain = async () => {
    const outcome = await send();
    if (outcome) toastResendOutcome(outcome, email, () => router.refresh());
  };

  return (
    <div role="region" aria-label="Confirm your email" className="border-b border-border bg-surface-sunken" data-unconfirmed-email-banner="">
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-2.5 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6",
          portal ? "max-w-5xl" : "max-w-[1440px] lg:px-8",
        )}
      >
        <p className="flex min-w-0 items-start gap-2 text-sm text-ink-secondary">
          <Mail aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-ink" />
          <span className="min-w-0">
            Please confirm your email. We sent a link to <span className="break-all font-medium text-ink">{email}</span>.
          </span>
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-2 pl-6 sm:pl-0">
          <Button size="sm" variant="outline" loading={pending} leadingIcon={<Send aria-hidden="true" />} onClick={sendAgain} data-resend-confirmation="">
            {pending ? "Sending…" : "Send again"}
          </Button>
          <Button size="sm" variant="ghost" href={accountHref}>
            Change email
          </Button>
        </div>
      </div>
    </div>
  );
}
