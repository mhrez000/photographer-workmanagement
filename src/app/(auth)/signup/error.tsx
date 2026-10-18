"use client";

import { AuthRouteError } from "@/components/auth/auth-route-error";

export default function SignUpError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <AuthRouteError error={error} retry={retry} title="Sign-up didn’t load" message="Something interrupted the page. Try again — nothing was created." />;
}
