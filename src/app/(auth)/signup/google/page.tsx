import type { Metadata } from "next";
import { AuthPageHeader } from "@/components/auth/auth-page-header";
import { GoogleSignUpForm, GoogleSignUpStartAgain } from "@/components/auth/google-signup-form";
import { SignedInNotice } from "@/components/auth/signed-in-notice";
import { googleAuthConfig } from "@/server/auth/google-config";
import { getViewer } from "@/server/auth/session";
import { homePathFor } from "@/server/page";
import { readPendingGoogleSignUp } from "@/server/services/googleAuth";

export const metadata: Metadata = { title: "Create your studio with Google", referrer: "no-referrer", robots: { index: false, follow: false } };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * /signup/google — the last step of "Continue with Google" for someone without a Proofline account (public; in
 * PUBLIC_PREFIXES). The verified Google identity waits in a signed, httpOnly, 15-minute cookie set by the callback;
 * this page only reads it (never trusts the query string for it). No / expired cookie → "Let's start that again" (or,
 * with Google sign-in switched off, "Signing up with Google isn't available" + Create your studio — UX-15); a
 * signed-in visitor with nothing pending gets the signed-in notice. `?from=signin` (they pressed Continue with Google
 * on the SIGN-IN page) explains that there is no account yet.
 */
export default async function GoogleSignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const fromSignIn = firstParam(params.from) === "signin";
  const pending = await readPendingGoogleSignUp();

  const viewer = await getViewer();
  if (!pending) {
    if (viewer) {
      return (
        <div className="flex flex-col gap-8">
          <AuthPageHeader title="You’re already signed in" lede="To create a different studio, log out first." />
          <SignedInNotice viewerName={viewer.name} viewerEmail={viewer.email} viewerRole={viewer.role} homeHref={homePathFor({ role: viewer.role })} returnTo="/signup" />
        </div>
      );
    }
    const googleAvailable = googleAuthConfig() !== null;
    return (
      <div className="flex flex-col gap-8">
        <AuthPageHeader title="Create your studio" lede={googleAvailable ? "Your Google sign-up needs a fresh start." : undefined} />
        <GoogleSignUpStartAgain googleAvailable={googleAvailable} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <AuthPageHeader
        title={fromSignIn ? "No account yet? Create your studio" : "Name your studio"}
        lede="You’re continuing with Google. Just name your studio and you’re in."
      />
      <GoogleSignUpForm email={pending.email} initialName={pending.name ?? ""} fromSignIn={fromSignIn} signedInAs={viewer?.name ?? null} />
    </div>
  );
}
