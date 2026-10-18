import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";

export default function InviteLoading() {
  return <AuthFormSkeleton fields={3} label="Opening your invite" />;
}
