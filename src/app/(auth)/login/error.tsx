"use client";

import { AuthRouteError } from "@/components/auth/auth-route-error";

export default function LoginError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <AuthRouteError error={error} retry={retry} title="Sign in didn’t load" message="Something interrupted the page. Try again." />;
}
