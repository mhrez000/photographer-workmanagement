"use client";

import { AuthRouteError } from "@/components/auth/auth-route-error";

export default function InviteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <AuthRouteError error={error} retry={retry} title="Your invite didn’t open" message="Something interrupted the page. Try again — the link itself is still fine." />;
}
