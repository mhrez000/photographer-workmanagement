import type { Metadata } from "next";
import { AuthPageHeader } from "@/components/auth/auth-page-header";
import { ContinueWithGoogle, GoogleResultAlert } from "@/components/auth/continue-with-google";
import { DemoPanel } from "@/components/auth/demo-panel";
import { FormAlert } from "@/components/auth/form-alert";
import { SignedInNotice } from "@/components/auth/signed-in-notice";
import { getDb } from "@/db/index";
import { demoSignInAvailable } from "@/server/auth/demo";
import { getViewer } from "@/server/auth/session";
import { hasSignedUp } from "@/server/auth/signed-up";
import { homePathFor } from "@/server/page";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * /login (docs/ACCOUNTS.md §1, §7).
 *
 * - Signed in (a valid session on this browser) → who is signed in, [Go to your studio / my jobs / See your work]
 *   [Log out] instead of the form; `?expired=1` never shows it (the proxy is throwing that cookie away).
 * - "Look around the demo" (`DemoPanel`): one button per persona, no emails or passwords anywhere. Shown only when
 *   demo sign-in is available here (`DEMO_SIGN_IN` not off AND a demo studio exists). Hidden where it would read as
 *   someone else's door: `?from=invite` (an invitee sent here from their invite page) and a browser that has
 *   created a real studio (`pl_signed_up`). `?demo=1` ("See the demo studio" on the landing page) always shows it,
 *   first and highlighted.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = firstParam(params.next);
  const expired = firstParam(params.expired) !== undefined;
  const demoAsked = firstParam(params.demo) !== undefined;
  const fromInvite = firstParam(params.from) === "invite";
  // Prefill from "Sign in instead" on the sign-up page (bounded; never trusted beyond the field value).
  const email = firstParam(params.email)?.slice(0, 254);

  const viewer = expired ? null : await getViewer();
  if (viewer) {
    return (
      <div className="flex flex-col gap-8">
        <AuthPageHeader title="You’re already signed in" lede={viewer.organisationName || undefined} />
        <SignedInNotice
          viewerName={viewer.name}
          viewerEmail={viewer.email}
          viewerRole={viewer.role}
          homeHref={homePathFor({ role: viewer.role })}
          returnTo={demoAsked ? "/login?demo=1" : "/login"}
        />
      </div>
    );
  }

  const demoAvailable = await demoSignInAvailable(getDb());
  const showDemo = demoAvailable && (demoAsked || (!fromInvite && !(await hasSignedUp())));
  const demoFirst = showDemo && demoAsked;
  const loggedOut = firstParam(params.logged_out) !== undefined;

  return (
    <div className="flex flex-col gap-8">
      <AuthPageHeader
        title={demoFirst ? "Look around the demo studio" : "Sign in to Proofline"}
        lede={demoFirst ? "Pick who to be and you’re in — no password needed. Or sign in with your own account below." : "Welcome back. Sign in with your email and password."}
      />
      {/* A Google round trip's result comes first, where someone back from Google looks (UX-16). */}
      <GoogleResultAlert surface="signin" result={firstParam(params.google)} />
      {demoFirst ? <DemoPanel highlighted /> : null}
      {demoAsked && !demoAvailable ? (
        <FormAlert tone="neutral">The demo studio isn’t open right now. Sign in with your own account, or create your studio.</FormAlert>
      ) : null}
      <LoginForm next={next} expired={expired} loggedOut={loggedOut} initialEmail={email} quiet={demoFirst} />
      {/* Accounts: AREA google's slot (renders nothing unless GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set). */}
      <ContinueWithGoogle intent="signin" next={next} />
      {showDemo && !demoFirst ? <DemoPanel /> : null}
    </div>
  );
}
