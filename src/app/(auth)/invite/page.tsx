import type { Metadata } from "next";
import { invalidInviteBody } from "@/components/auth/auth-helpers";
import { AuthPageHeader } from "@/components/auth/auth-page-header";
import { InvalidLinkCard } from "@/components/auth/invalid-link-card";

export const metadata: Metadata = { title: "Invite link no longer valid" };

/**
 * /invite with no token (a link cut off before the token, or typed by hand): the same friendly dead-link
 * card as a bad token, instead of the app's 404 with "Browse jobs" buttons that mean nothing to someone
 * who has no account yet. Public (src/proxy.ts lets /invite through).
 */
export default function InviteWithoutTokenPage() {
  return (
    <div className="flex flex-col gap-8">
      <AuthPageHeader title="This invite link is no longer valid" lede="The link is missing its last part." />
      <InvalidLinkCard body={invalidInviteBody(null)} actionHref="/login?from=invite" actionLabel="Sign in" />
    </div>
  );
}
