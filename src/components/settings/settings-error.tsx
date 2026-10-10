"use client";

import * as React from "react";
import { PageContainer } from "@/components/shell/page-container";
import { ErrorState } from "@/components/ui/error-state";

export interface SettingsErrorProps {
  error: Error & { digest?: string };
  retry: () => void;
  /** What failed to load, e.g. "users". */
  what?: string;
}

/** Shared error boundary body for every settings route segment. */
export function SettingsError({ error, retry, what = "these settings" }: SettingsErrorProps) {
  return (
    <PageContainer width="narrow">
      <ErrorState
        title={`Couldn't load ${what}`}
        message="Something interrupted this page. Your saved settings are safe — try again, and if it keeps happening let the studio owner know."
        onRetry={retry}
        homeHref="/dashboard"
        digest={error.digest}
      />
    </PageContainer>
  );
}
