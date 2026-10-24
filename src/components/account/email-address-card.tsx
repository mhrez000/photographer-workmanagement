import { Mail } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { formatDateTime } from "@/lib/dates";
import type { AccountSecurityOverview } from "@/lib/types";
import { EmailChangePanel } from "./email-change-panel";
import { EmailConfirmationStatus } from "./email-confirmation-status";

/**
 * "Email" on Settings → My account and /portal/account (docs/ACCOUNTS-PLAN.md §4, AREA account). `id="email"` is
 * the anchor the "Please confirm your email" banner's "Change email" points at. Shows the address with its
 * confirmation status (`EmailConfirmationStatus`, AREA verify), a waiting change ("Waiting for you to confirm y ·
 * [Send again] [Cancel change]") and "Change email" (new address + current password). Google-only accounts are
 * told to set a password first. A server component: the status can be a server or client component, the
 * interactive half is `EmailChangePanel`.
 */
export function EmailAddressCard({ overview }: { overview: AccountSecurityOverview }) {
  const pending = overview.pendingEmailChange
    ? { newEmail: overview.pendingEmailChange.newEmail, expiresLabel: formatDateTime(overview.pendingEmailChange.expiresAt, overview.timezone) }
    : null;
  return (
    <SectionCard id="email" title="Email" description="Where Proofline sends your links and notices. You sign in with it." actions={<Mail aria-hidden="true" className="size-4 text-ink-subtle" />}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="break-all text-sm font-medium text-ink" data-account-email="">
            {overview.email}
          </p>
          <EmailConfirmationStatus overview={overview} />
        </div>
        {overview.isDemo ? (
          <p className="text-sm text-ink-secondary">Email addresses can&apos;t be changed in the demo studio.</p>
        ) : (
          <EmailChangePanel email={overview.email} hasPassword={overview.hasPassword} emailConfigured={overview.emailConfigured} pending={pending} />
        )}
      </div>
    </SectionCard>
  );
}
