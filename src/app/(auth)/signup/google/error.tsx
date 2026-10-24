"use client";

import { AuthRouteError } from "@/components/auth/auth-route-error";

export default function GoogleSignUpError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <AuthRouteError error={error} retry={retry} title="This page didn’t load" message="Something interrupted the page. Try again — nothing was created." />;
}
