"use client";

import { RouteError } from "@/components/common";

export default function JobHistoryError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <RouteError error={error} retry={retry} title="The history didn't load" message="Nothing was changed. Try again, or go back to Jobs." homeHref="/jobs" homeLabel="Back to Jobs" />;
}
