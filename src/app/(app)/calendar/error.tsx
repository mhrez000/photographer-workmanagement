"use client";

import { RouteError } from "@/components/common/route-error";

export default function CalendarError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <RouteError error={error} retry={retry} title="The calendar didn't load" message="Something interrupted the calendar. Try again." homeHref="/my-jobs" homeLabel="Go to My jobs" />;
}
