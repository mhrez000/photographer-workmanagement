"use client";

import { PageContainer } from "@/components/shell";
import { ErrorState } from "@/components/ui/error-state";

export default function TimelineError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer>
      <ErrorState
        title="The timeline could not be loaded"
        message="Something went wrong while building the Gantt view. Try again, or open the Kanban board instead."
        onRetry={retry}
        homeHref="/workspace/kanban"
        homeLabel="Open Kanban"
        digest={error.digest}
      />
    </PageContainer>
  );
}
