"use client";

import { PageContainer } from "@/components/shell/page-container";
import { ErrorState } from "@/components/ui/error-state";

export default function EditJobError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer>
      <ErrorState
        title="This job couldn't be opened for editing"
        message="Something went wrong loading the job. No changes were made — try again."
        onRetry={retry}
        homeHref="/workspace/all"
        homeLabel="Back to All Work"
        digest={error.digest}
      />
    </PageContainer>
  );
}
