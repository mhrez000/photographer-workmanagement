import type { Metadata } from "next";
import { AuthPageHeader } from "@/components/auth/auth-page-header";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { TokenSchema } from "@/lib/validation/auth";

export const metadata: Metadata = { title: "Choose a new password" };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

  return (
    <div className="flex flex-col gap-8">
      <AuthPageHeader
        title={token ? "Choose a new password" : "Reset your password"}
        lede={token ? "Make it at least 10 characters. A short sentence you’ll remember works well." : undefined}
      />
      <ResetPasswordForm token={token} />
    </div>
  );
}
