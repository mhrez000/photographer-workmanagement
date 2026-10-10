"use client";

import { RouteError } from "@/components/common/route-error";

export default function PortalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="This page didn't load"
      message="Something interrupted loading your work. Nothing was changed — try again in a moment."
      homeHref="/portal"
      homeLabel="Your work"
    />
  );
}
