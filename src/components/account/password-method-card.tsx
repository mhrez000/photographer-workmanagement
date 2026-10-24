import { KeyRound } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import type { AccountSecurityOverview } from "@/lib/types";
import { ChangePasswordForm, SetPasswordForm } from "./password-forms";

/**
 * "Password" on Settings → My account and /portal/account (docs/ACCOUNTS-PLAN.md §4, AREA account). Has a
 * password → change it (current + new; every other device is logged out, "Your password was changed" is emailed).
 * No password (signed up with Google) → "Set a password" (POST /api/auth/set-password). `id="password"` is the
 * anchor the Email card's "Set a password first" points at. The demo studio never reaches here
 * (`AccountSecuritySection` shows one read-only notice), but the card still explains itself if it ever does.
 */
export function PasswordMethodCard({ overview }: { overview: AccountSecurityOverview }) {
  const icon = <KeyRound aria-hidden="true" className="size-4 text-ink-subtle" />;
  if (overview.isDemo) {
    return (
      <SectionCard id="password" title="Password" actions={icon} data-password-card="demo">
        <p className="text-sm text-ink-secondary">Passwords can&apos;t be changed in the demo studio.</p>
      </SectionCard>
    );
  }
  if (!overview.hasPassword) {
    return (
      <SectionCard
        id="password"
        title="Set a password"
        description={
          overview.google.connected
            ? "You sign in with Google. Add a password so you can also sign in with your email."
            : "Your account has no password yet. Add one to sign in with your email."
        }
        actions={icon}
        data-password-card="set"
      >
        <SetPasswordForm />
      </SectionCard>
    );
  }
  return (
    <SectionCard id="password" title="Password" description="At least 10 characters. A short sentence you’ll remember works well." actions={icon} data-password-card="change">
      <ChangePasswordForm />
    </SectionCard>
  );
}
