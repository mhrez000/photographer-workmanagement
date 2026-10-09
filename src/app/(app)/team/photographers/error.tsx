"use client";

import { RouteError } from "@/components/common/route-error";

export default function ErrorBoundary({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Couldn't load the photographers"
      message="The photographer directory didn't load. Try again in a moment."
    />
  );
}
