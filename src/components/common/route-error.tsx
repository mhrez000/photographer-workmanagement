"use client";

import { PageContainer } from "@/components/shell/page-container";
import { ErrorState } from "@/components/ui/error-state";

export interface RouteErrorProps {
  error: Error & { digest?: string };
  retry: () => void;
  title: string;
  message: string;
  homeHref?: string;
  homeLabel?: string;
}

/** Shared body for route `error.tsx` boundaries (Next 16 props: `{ error, retry }`). */
export function RouteError({ error, retry, title, message, homeHref = "/", homeLabel }: RouteErrorProps) {
  return (
    <PageContainer>
      <div className="flex flex-1 items-center justify-center py-16">
        <ErrorState title={title} message={message} onRetry={retry} homeHref={homeHref} homeLabel={homeLabel} digest={error.digest} />
      </div>
    </PageContainer>
  );
}
