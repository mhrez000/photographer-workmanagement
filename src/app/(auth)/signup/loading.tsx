import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";

export default function SignUpLoading() {
  return <AuthFormSkeleton fields={4} label="Loading create your studio" />;
}
