"use client";

import { PageContainer } from "@/components/shell/page-container";
import { ErrorState } from "@/components/ui/error-state";

export default function MyWorkError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer>
      <ErrorState
        title="Your queue didn't load"
        message="Something interrupted loading My Work. Your jobs are safe — try again in a moment."
        onRetry={retry}
        homeHref="/dashboard"
        digest={error.digest}
      />
    </PageContainer>
  );
}
