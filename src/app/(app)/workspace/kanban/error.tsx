"use client";

import { PageContainer } from "@/components/shell";
import { ErrorState } from "@/components/ui/error-state";

export default function KanbanError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer>
      <ErrorState
        title="The board could not be loaded"
        message="Something went wrong while loading the board. Your jobs are safe — try again, or open the Jobs list."
        onRetry={retry}
        homeHref="/jobs"
        homeLabel="Open Jobs"
        digest={error.digest}
      />
    </PageContainer>
  );
}
