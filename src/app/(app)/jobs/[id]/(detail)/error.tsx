"use client";

import { PageContainer } from "@/components/shell";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";

export default function JobDetailError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer width="narrow">
      <Card>
        <ErrorState
          title="This job didn't load"
          message="Something went wrong while loading the job, its files or its messages. Nothing was changed — try again, or go back to Jobs."
          onRetry={retry}
          homeHref="/jobs"
          homeLabel="Back to Jobs"
          digest={error.digest}
        />
      </Card>
    </PageContainer>
  );
}
