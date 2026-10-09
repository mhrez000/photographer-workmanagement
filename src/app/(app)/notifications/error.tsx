"use client";

import { PageContainer } from "@/components/shell";
import { ErrorState } from "@/components/ui/error-state";

export default function NotificationsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageContainer width="narrow">
      <ErrorState
        title="Notifications couldn't load"
        message="We couldn't fetch your notifications just now. Try again in a moment."
        onRetry={retry}
        homeHref="/dashboard"
        digest={error.digest}
        size="lg"
      />
    </PageContainer>
  );
}
