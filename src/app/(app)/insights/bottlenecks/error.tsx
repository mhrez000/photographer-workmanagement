"use client";

import { RouteError } from "@/components/common/route-error";

export default function ErrorBoundary({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Couldn't check for bottlenecks"
      message="The bottleneck rules didn't run. Try again in a moment."
    />
  );
}
