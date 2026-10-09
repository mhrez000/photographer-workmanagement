"use client";

import { PageContainer } from "@/components/shell";
import { ErrorState } from "@/components/ui/error-state";

export default function JobsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer>
      <ErrorState
        title="Jobs didn't load"
        message="Something interrupted the job list. Try again — your tab and search are kept in the link."
        onRetry={retry}
        homeHref="/dashboard"
        digest={error.digest}
      />
    </PageContainer>
  );
}
