"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AccountSecurityOverview } from "@/lib/types";
import { toastResendOutcome, useResendEmailConfirmation } from "./resend-email-confirmation";

/**
 * Whether the address on the Email card is confirmed (AREA verify, docs/ACCOUNTS-PLAN.md §4) — rendered INSIDE
 * `EmailAddressCard`. A "Confirmed" chip, or "Not confirmed yet · [Send again]". Only when email is configured and
 * the studio is not the demo (without a mail provider the whole feature is invisible).
 */
export function EmailConfirmationStatus({ overview }: { overview: AccountSecurityOverview }) {
  if (!overview.emailConfigured || overview.isDemo) return null;
  if (overview.emailVerifiedAt !== null) {
    return (
      <div data-email-confirmation="confirmed">
        <Badge variant="success" dot>
          Confirmed
        </Badge>
      </div>
    );
  }
  return <NotConfirmedYet email={overview.email} />;
}

function NotConfirmedYet({ email }: { email: string }) {
  const router = useRouter();
  const { pending, send } = useResendEmailConfirmation();

  const sendAgain = async () => {
    const outcome = await send();
    if (outcome) toastResendOutcome(outcome, email, () => router.refresh());
  };

  return (
    <div className="flex flex-col items-start gap-1.5" data-email-confirmation="unconfirmed">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="attention" dot>
          Not confirmed yet
        </Badge>
        <span aria-hidden="true" className="text-ink-subtle">
          ·
        </span>
        <Button size="sm" variant="link" loading={pending} onClick={sendAgain} data-resend-confirmation="">
          {pending ? "Sending…" : "Send again"}
        </Button>
      </div>
      <p className="text-xs text-ink-muted">Open the link we emailed you to confirm this address. Links work for 24 hours.</p>
    </div>
  );
}
