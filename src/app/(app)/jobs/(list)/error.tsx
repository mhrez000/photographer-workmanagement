"use client";

import { RouteError } from "@/components/common/route-error";

export default function JobsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Jobs didn't load"
      message="Something interrupted the job list. Try again — your tab and filters are kept in the link."
      homeHref="/home"
      homeLabel="Go to Home"
    />
  );
}
