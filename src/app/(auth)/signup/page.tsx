import type { Metadata } from "next";
import { AuthPageHeader } from "@/components/auth/auth-page-header";
import { ContinueWithGoogle, GoogleResultAlert } from "@/components/auth/continue-with-google";
import { SignedInNotice } from "@/components/auth/signed-in-notice";
import { SignUpForm } from "@/components/auth/signup-form";
import { getViewer } from "@/server/auth/session";
import { homePathFor } from "@/server/page";

export const metadata: Metadata = { title: "Create your studio" };

/**
 * /signup — "Create your studio" (POST /api/auth/signup). Public. Free to start: the studio, its owner, the five
 * stages and the usual types of shoot are created in one go. A signed-in person sees who is signed in, [Go to your
 * studio] [Log out] instead of the form (docs/ACCOUNTS.md §1; the proxy no longer redirects) — logging out lands back
 * here, ready to create a new studio. `?expired=1` never shows the notice.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const google = Array.isArray(params.google) ? params.google[0] : params.google;
  const expired = params.expired !== undefined;

  const viewer = expired ? null : await getViewer();
  if (viewer) {
    return (
      <div className="flex flex-col gap-8">
        <AuthPageHeader title="You’re already signed in" lede="To create a different studio, log out first." />
        <SignedInNotice viewerName={viewer.name} viewerEmail={viewer.email} viewerRole={viewer.role} homeHref={homePathFor({ role: viewer.role })} returnTo="/signup" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <AuthPageHeader title="Create your studio" lede="You’ll be the owner. Invite your editors and clients once you’re in." />
      {/* A Google round trip's result comes first, where someone back from Google looks (UX-16). */}
      <GoogleResultAlert surface="signup" result={google} />
      <SignUpForm />
      {/* Accounts: AREA google's slot (renders nothing unless Google sign-in is configured). */}
      <ContinueWithGoogle intent="signup" />
    </div>
  );
}
