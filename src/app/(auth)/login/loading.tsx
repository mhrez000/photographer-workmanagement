import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";

export default function LoginLoading() {
  return <AuthFormSkeleton fields={2} label="Loading sign in" />;
}
