import type { Metadata } from "next";
import { AccountSecuritySection } from "@/components/account/account-security-section";
import { PageContainer } from "@/components/shell/page-container";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { NotificationGroupsForm } from "@/components/settings/notification-groups-form";
import { ProfileForm } from "@/components/settings/profile-forms";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate } from "@/lib/dates";
import { countOldUnreadNotifications } from "@/server/queries/account";
import { getAccountSecurity } from "@/server/queries/accountSecurity";
import { getNotificationPrefs } from "@/server/queries/settings";
import { getUserDetail } from "@/server/queries/users";
import { advancedEnabled, guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "My account" };

/**
 * Settings → My account (docs/SIMPLIFICATION-PLAN.md §3): profile, sign-in & security (accounts,
 * docs/ACCOUNTS-PLAN.md §6: email + confirmation, password, Google, sign out of other devices), notifications
 * (the 8 groups + "Mark old updates as read") and appearance. Density only with Advanced tools on.
 */
export default async function AccountPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "notification.prefs");
  const tz = ctx.settings.timezone;
  const detail = await load(() => getUserDetail(db, ctx, ctx.userId ?? ""));
  const profile = detail.profile;
  if (!profile) return null; // self always gets the full profile.
  const prefs = await load(() => getNotificationPrefs(db, ctx));
  const oldUnread = await load(() => countOldUnreadNotifications(db, ctx));
  const security = await load(() => getAccountSecurity(db, ctx));

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Settings"
        title="My account"
        description={
          <>
            {profile.email} · with the studio since {formatDate(profile.createdAt, tz)}
          </>
        }
      />
      <ProfileForm profile={profile} timeZone={tz} showTitle={advancedEnabled(ctx)} demo={ctx.isDemo === true} />
      <AccountSecuritySection overview={security} />
      <NotificationGroupsForm userId={profile.id} prefs={prefs} oldUnreadCount={oldUnread} role={ctx.role} />
      <AppearanceSettings showDensity={advancedEnabled(ctx)} />
    </PageContainer>
  );
}
