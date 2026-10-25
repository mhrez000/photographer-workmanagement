import { MonitorSmartphone } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import type { AccountSecurityOverview } from "@/lib/types";
import { SignOutOthersPanel } from "./sign-out-others-panel";

/**
 * "Other devices" on Settings → My account and /portal/account (docs/ACCOUNTS-PLAN.md §4, AREA account):
 * "Log out of other devices" with a confirm step (POST /api/auth/sign-out-others); this browser stays signed in.
 */
export function SignOutOthersCard({ overview }: { overview: AccountSecurityOverview }) {
  const icon = <MonitorSmartphone aria-hidden="true" className="size-4 text-ink-subtle" />;
  if (overview.isDemo) {
    return (
      <SectionCard id="devices" title="Other devices" actions={icon} data-sign-out-others-card="demo">
        <p className="text-sm text-ink-secondary">Logging out of other devices is turned off in the demo studio.</p>
      </SectionCard>
    );
  }
  return (
    <SectionCard id="devices" title="Other devices" actions={icon} data-sign-out-others-card="">
      <SignOutOthersPanel />
    </SectionCard>
  );
}
