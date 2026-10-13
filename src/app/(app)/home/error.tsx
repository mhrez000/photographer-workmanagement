"use client";

import { RouteError } from "@/components/common/route-error";

export default function HomeError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <RouteError error={error} retry={retry} title="Home didn't load" message="Something interrupted the page. Try again." homeHref="/jobs" homeLabel="Go to Jobs" />;
}
