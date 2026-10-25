import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { TokenSchema } from "@/lib/validation/auth";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The tab says what the page says (UX-08): a link of the right shape → "Choose a new password", else "Reset your password". */
export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const params = await searchParams;
  const ok = TokenSchema.safeParse(firstParam(params.token) ?? "").success;
  return { title: ok ? "Choose a new password" : "Reset your password", referrer: "no-referrer" };
}

/**
 * /reset-password?token=… (POST /api/auth/reset-password). Public. Only the token's SHAPE is checked
 * here (a missing or mangled one shows the dead-link card at once); whether it is live is decided by
 * the API on submit, so nothing about the token leaks before the person commits a password.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const parsed = TokenSchema.safeParse(firstParam(params.token) ?? "");
  const token = parsed.success ? parsed.data : null;

  // The form draws the heading itself: it changes to "Reset your password" when the link turns out to be dead.
  return <ResetPasswordForm token={token} />;
}
