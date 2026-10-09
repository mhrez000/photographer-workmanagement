"use client";

import { PageContainer } from "@/components/shell/page-container";
import { ErrorState } from "@/components/ui/error-state";

export default function NewJobError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer>
      <ErrorState
        title="The new-job form didn't load"
        message="We couldn't load clients, job types or people for the form. Nothing was created — try again."
        onRetry={retry}
        homeHref="/workspace/my"
        homeLabel="Back to My Work"
        digest={error.digest}
      />
    </PageContainer>
  );
}
