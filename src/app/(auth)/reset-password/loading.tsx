import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";

export default function ResetPasswordLoading() {
  return <AuthFormSkeleton fields={2} label="Loading reset password" />;
}
