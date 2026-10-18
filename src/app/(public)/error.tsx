"use client";

import { ErrorState } from "@/components/ui/error-state";

/** Error boundary for the public front door. The header and footer (the layout) stay in place. */
export default function PublicError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col items-center px-4 py-20 sm:px-6">
      <ErrorState
        title="This page did not load"
        message="Something went wrong while opening the page. Trying again usually fixes it; you can also sign in directly."
        onRetry={reset}
        homeHref="/login"
        digest={error.digest}
        size="lg"
      />
    </div>
  );
}
