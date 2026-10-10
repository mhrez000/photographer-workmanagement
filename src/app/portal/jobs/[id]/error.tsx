"use client";

import { RouteError } from "@/components/common/route-error";

export default function PortalJobError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="This job didn't load"
      message="Something interrupted loading this job. Nothing was changed — try again."
      homeHref="/portal"
      homeLabel="Your work"
    />
  );
}
