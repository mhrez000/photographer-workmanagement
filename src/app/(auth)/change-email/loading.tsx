import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";

export default function ChangeEmailLoading() {
  return <AuthFormSkeleton fields={1} label="Loading confirm your new email" />;
}
