"use client";

import { PageContainer } from "@/components/shell";
import { ErrorState } from "@/components/ui/error-state";

export default function CalendarError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer>
      <ErrorState
        title="The calendar could not be loaded"
        message="Something went wrong while loading shoot dates and deadlines. Try again, or check the All Work list."
        onRetry={retry}
        homeHref="/workspace/all"
        homeLabel="Open All Work"
        digest={error.digest}
      />
    </PageContainer>
  );
}
