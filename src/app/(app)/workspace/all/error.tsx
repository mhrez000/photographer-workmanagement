"use client";

import { PageContainer } from "@/components/shell";
import { ErrorState } from "@/components/ui/error-state";

export default function AllWorkError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer>
      <ErrorState
        title="All Work didn't load"
        message="Something interrupted the job table. Try again — your filters are kept in the link."
        onRetry={retry}
        homeHref="/dashboard"
        digest={error.digest}
      />
    </PageContainer>
  );
}
