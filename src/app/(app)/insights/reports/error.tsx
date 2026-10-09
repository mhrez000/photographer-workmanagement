"use client";

import { RouteError } from "@/components/common/route-error";

export default function ErrorBoundary({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Couldn't build the report"
      message="The report for this range didn't load. Try again, or pick a different range."
    />
  );
}
