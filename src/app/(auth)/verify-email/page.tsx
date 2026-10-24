import type { Metadata } from "next";
import { AuthPageHeader } from "@/components/auth/auth-page-header";
import { VerifyEmailForm, type VerifyEmailViewer } from "@/components/auth/verify-email-form";
import { TokenSchema } from "@/lib/validation/auth";
import { loginRedirectTarget } from "@/server/auth/redirect";
import { getViewer } from "@/server/auth/session";
import { accountPathFor } from "@/server/queries/accountSecurity";

// The token is in this page's address: never send it on to anyone in a Referer header.
export const metadata: Metadata = { title: "Confirm your email", referrer: "no-referrer", robots: { index: false, follow: false } };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * /verify-email?token=… — "Confirm your email" (AREA verify, docs/ACCOUNTS.md §3). Public: works signed in or out.
 * Only the token's SHAPE is checked here (a missing or mangled one shows the dead-link card at once). Opening the page
 * confirms NOTHING — mail scanners open links — the person presses "Confirm my email" (POST /api/auth/verify-email).
 * When someone is signed in, the island also gets their address (for "Send a new link") and their landing page.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const parsed = TokenSchema.safeParse(firstParam(params.token) ?? "");
  const token = parsed.success ? parsed.data : null;
  const signedIn = await getViewer();
  const viewer: VerifyEmailViewer | null = signedIn
    ? {
        email: signedIn.email,
        confirmed: signedIn.emailVerifiedAt !== null || signedIn.isDemo,
        homeHref: loginRedirectTarget(signedIn.role, null),
        accountHref: `${accountPathFor(signedIn.role)}#email`,
      }
    : null;

  return (
    <div className="flex flex-col gap-8">
      <AuthPageHeader title="Confirm your email" />
      <VerifyEmailForm token={token} viewer={viewer} />
    </div>
  );
}
