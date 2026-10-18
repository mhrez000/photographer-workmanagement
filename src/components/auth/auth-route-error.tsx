"use client";

import { ErrorState } from "@/components/ui/error-state";

export interface AuthRouteErrorProps {
  error: Error & { digest?: string };
  retry: () => void;
  title: string;
  message?: string;
}

/** Shared body for the front door's `error.tsx` boundaries (inside the (auth) layout's form column). */
export function AuthRouteError({ error, retry, title, message = "Something interrupted the page. Try again, or go back to sign in." }: AuthRouteErrorProps) {
  return (
    <div className="rounded-lg border border-border bg-surface shadow-md">
      <ErrorState title={title} message={message} onRetry={retry} homeHref="/login" homeLabel="Back to sign in" digest={error.digest} size="sm" />
    </div>
  );
}
