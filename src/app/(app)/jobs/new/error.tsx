"use client";

import { PageContainer } from "@/components/shell/page-container";
import { ErrorState } from "@/components/ui/error-state";

export default function NewJobError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer width="narrow">
      <ErrorState
        title="The new-job form didn't load"
        message="We couldn't load your clients, types of shoot or editors. Nothing was created — try again."
        onRetry={retry}
        homeHref="/jobs"
        homeLabel="Back to Jobs"
        digest={error.digest}
      />
    </PageContainer>
  );
}
