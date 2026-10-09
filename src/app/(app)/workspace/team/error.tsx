"use client";

import { PageContainer } from "@/components/shell";
import { ErrorState } from "@/components/ui/error-state";

export default function TeamWorkError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer>
      <ErrorState
        title="Team Work didn't load"
        message="Something interrupted loading the team's jobs. Try again in a moment."
        onRetry={retry}
        homeHref="/dashboard"
        digest={error.digest}
      />
    </PageContainer>
  );
}
