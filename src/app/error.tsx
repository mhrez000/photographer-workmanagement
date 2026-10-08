"use client";

import * as React from "react";
import { ErrorState } from "@/components/ui/error-state";
import { BrandMark } from "@/components/shell/brand-mark";

export default function GlobalErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-canvas px-4 py-16">
      <BrandMark size={36} className="mb-8" />
      <ErrorState
        title="Something went wrong"
        message="An unexpected error interrupted this page. Trying again usually fixes it; if not, head back to the dashboard."
        onRetry={retry}
        homeHref="/dashboard"
        digest={error.digest}
        size="lg"
      />
    </div>
  );
}
