import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";

export default function ForgotPasswordLoading() {
  return <AuthFormSkeleton fields={1} label="Loading forgot password" />;
}
