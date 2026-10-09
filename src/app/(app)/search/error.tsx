"use client";

import { RouteError } from "@/components/common/route-error";

export default function SearchError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="Search didn't finish"
      message="Something interrupted the search. Try again, or open the job directly by its number."
    />
  );
}
