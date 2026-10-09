"use client";

import { RouteError } from "@/components/common/route-error";

export default function ErrorBoundary({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Couldn't load workloads"
      message="Editor workloads didn't load. Try again in a moment."
    />
  );
}
