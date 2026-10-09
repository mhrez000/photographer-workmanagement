"use client";

import { RouteError } from "@/components/common/route-error";

export default function ActivityError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="The activity log didn't load"
      message="Nothing has been lost — the log is permanent. Try again in a moment."
    />
  );
}
