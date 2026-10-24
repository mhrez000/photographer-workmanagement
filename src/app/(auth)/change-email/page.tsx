import type { Metadata } from "next";
import { AuthPageHeader } from "@/components/auth/auth-page-header";
import { ConfirmEmailChangeForm } from "@/components/auth/confirm-email-change-form";
import { TokenSchema } from "@/lib/validation/auth";
import { getViewer } from "@/server/auth/session";
import { accountPathFor } from "@/server/queries/accountSecurity";

export const metadata: Metadata = {
  title: "Confirm your new email",
  // The link carries a one-time token: never hand it to another site in a Referer header.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * /change-email?token=… — the link "Confirm your new email address" sends to the NEW address (docs/ACCOUNTS.md
 * "My account"). Public: it works signed in or out and never signs anyone in. Only the token's SHAPE is checked
 * here (a missing or mangled one shows the dead-link card at once); the change happens when the person presses
 * the button (POST /api/auth/email-change/confirm), never when the page opens — mail scanners open links.
 */
export default async function ChangeEmailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const parsed = TokenSchema.safeParse(firstParam(params.token) ?? "");
  const token = parsed.success ? parsed.data : null;
  const viewer = await getViewer();
  const fallbackHref = viewer ? `${accountPathFor(viewer.role)}#email` : "/login";
  const fallbackLabel = viewer ? "Go to my account" : "Go to sign in";

  return (
    <div className="flex flex-col gap-8">
      <AuthPageHeader title="Confirm your new email" />
      <ConfirmEmailChangeForm token={token} fallbackHref={fallbackHref} fallbackLabel={fallbackLabel} />
    </div>
  );
}
