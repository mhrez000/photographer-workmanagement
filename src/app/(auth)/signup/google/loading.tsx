import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";

export default function GoogleSignUpLoading() {
  return <AuthFormSkeleton fields={3} label="Loading create your studio with Google" />;
}
