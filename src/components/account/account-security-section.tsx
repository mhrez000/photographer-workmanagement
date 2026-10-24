import { FlaskConical } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { Button } from "@/components/ui/button";
import type { AccountSecurityOverview } from "@/lib/types";
import { EmailAddressCard } from "./email-address-card";
import { GoogleSignInCard } from "./google-sign-in-card";
import { PasswordMethodCard } from "./password-method-card";
import { SignOutOthersCard } from "./sign-out-others-card";

/**
 * "Sign-in & security" on Settings → My account and /portal/account (docs/ACCOUNTS-PLAN.md §6). FOUNDATION-owned
 * composition; each card has one owner: Email [account] ⊃ confirmation status [verify], Password [account],
 * Google [google], Log out of other devices [account]. In the demo studio everything is read-only: one notice.
 */
export function AccountSecuritySection({ overview }: { overview: AccountSecurityOverview }) {
  if (overview.isDemo) {
    return (
      <SectionCard
        id="email"
        title="Sign-in & security"
        actions={<FlaskConical aria-hidden="true" className="size-4 text-ink-subtle" />}
        data-demo-account-notice=""
      >
        <div className="flex flex-col items-start gap-3 text-sm text-ink-secondary">
          <p>
            You&apos;re in the demo studio, so the email, password and sign-in settings of{" "}
            <span className="font-medium text-ink">{overview.email}</span> can&apos;t be changed here.
          </p>
          <Button href="/signup" size="sm" variant="outline">
            Create your own studio
          </Button>
        </div>
      </SectionCard>
    );
  }
  return (
    <div className="flex flex-col gap-6" data-account-security="">
      <EmailAddressCard overview={overview} />
      <PasswordMethodCard overview={overview} />
      <GoogleSignInCard overview={overview} />
      <SignOutOthersCard overview={overview} />
    </div>
  );
}
