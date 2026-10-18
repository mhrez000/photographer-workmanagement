import type { Metadata } from "next";
import { AuthPageHeader } from "@/components/auth/auth-page-header";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata: Metadata = { title: "Forgot password" };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** /forgot-password (POST /api/auth/forgot-password). Public. `?email=` prefills the field from the sign-in page. */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const email = firstParam(params.email)?.slice(0, 254) ?? "";

  return (
    <div className="flex flex-col gap-8">
      <AuthPageHeader title="Forgot your password?" lede="Tell us your email and we’ll send a link to choose a new one." />
      <ForgotPasswordForm initialEmail={email} />
    </div>
  );
}
