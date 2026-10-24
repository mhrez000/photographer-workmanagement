import type { Metadata } from "next";
import { AccountSecuritySection } from "@/components/account/account-security-section";
import { SectionCard } from "@/components/common/section-card";
import { PortalNameForm, PortalNotificationPrefs } from "@/components/portal/portal-account-forms";
import { getViewer } from "@/server/auth/session";
import { load, portalPageContext } from "@/server/page";
import { getPortalNotificationPrefs } from "@/server/services/portal";
import { getAccountSecurity } from "@/server/queries/accountSecurity";
import { getPortalProfile } from "@/server/queries/portal";

export const metadata: Metadata = { title: "My account" };

/**
 * /portal/account — name, sign-in & security (accounts, docs/ACCOUNTS-PLAN.md §6: email + confirmation, password,
 * Google, sign out of other devices) and the three client notification toggles (docs/ROLES.md §7.7).
 */
export default async function PortalAccountPage() {
  const { ctx, db } = await portalPageContext();
  const viewer = await getViewer();
  const profile = await load(() => getPortalProfile(db, ctx));
  const prefs = await load(() => getPortalNotificationPrefs(db, ctx));
  const security = await load(() => getAccountSecurity(db, ctx));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">My account</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Your portal account for {viewer?.clientName ?? "your company"} at {viewer?.organisationName ?? "your studio"}.
        </p>
      </header>
      <SectionCard title="Profile">
        <PortalNameForm name={profile.name} version={profile.version} />
      </SectionCard>
      {/* Each card renders its own SectionCard (the self-service /api/auth/* routes, any signed-in user). */}
      <AccountSecuritySection overview={security} />
      <SectionCard title="Notifications" description="Shown on the bell in the portal.">
        <PortalNotificationPrefs prefs={prefs.map((p) => ({ type: p.type, label: p.label, enabled: p.enabled }))} />
      </SectionCard>
    </div>
  );
}
