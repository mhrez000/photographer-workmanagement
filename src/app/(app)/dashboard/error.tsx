"use client";

import { PageContainer } from "@/components/shell";
import { ErrorState } from "@/components/ui/error-state";

export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer>
      <ErrorState
        title="The dashboard couldn't load"
        message="Something went wrong while gathering your numbers. Try again — your work is safe."
        onRetry={retry}
        homeHref="/workspace/my"
        homeLabel="Go to My Work"
        digest={error.digest}
        size="lg"
      />
    </PageContainer>
  );
}
