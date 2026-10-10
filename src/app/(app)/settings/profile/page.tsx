import type { Metadata } from "next";
import { PageContainer } from "@/components/shell/page-container";
import { editorFlagsOf, memberFlagsOf } from "@/components/settings/permission-copy";
import { ChangePasswordForm, ProfileForm, YourAccessCard } from "@/components/settings/profile-forms";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate, formatDateTime } from "@/lib/dates";
import { getUserDetail } from "@/server/queries/users";
import { personaOf } from "@/server/auth/permissions";
import { load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Your profile" };

export default async function ProfileSettingsPage() {
  const { ctx, db } = await pageContext();
  const tz = ctx.settings.timezone;
  const detail = await load(() => getUserDetail(db, ctx, ctx.userId ?? ""));
  const profile = detail.profile;
  if (!profile) return null; // self always gets the full profile.
  // Effective switches from the context (admins: every member switch on, docs/ROLES.md §2.1).
  const persona = personaOf(ctx);

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Settings · Personal"
        title="Your profile"
        description={
          <>
            Member since {formatDate(profile.createdAt, tz)}
            {profile.lastLoginAt ? ` · signed in ${formatDateTime(profile.lastLoginAt, tz)}` : ""}
            {detail.teams.length > 0 ? ` · ${detail.teams.map((t) => t.name).join(", ")}` : ""}
          </>
        }
      />
      <ProfileForm profile={profile} timeZone={tz} />
      {persona !== "client" ? (
        <YourAccessCard persona={persona} memberFlags={memberFlagsOf(ctx)} editorFlags={editorFlagsOf(ctx)} isPrimaryOwner={ctx.isPrimaryOwner} />
      ) : null}
      <ChangePasswordForm />
    </PageContainer>
  );
}
