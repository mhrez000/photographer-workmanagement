import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";

export default function VerifyEmailLoading() {
  return <AuthFormSkeleton fields={1} label="Opening your confirmation link" />;
}
