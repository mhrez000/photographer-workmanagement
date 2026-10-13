import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export interface ErrorStateProps extends Omit<React.ComponentPropsWithRef<"div">, "title"> {
  title?: React.ReactNode;
  message?: React.ReactNode;
  /** Retry handler (only usable from client components). */
  onRetry?: () => void;
  retryLabel?: string;
  /** Alternative to onRetry: a link to navigate to. */
  homeHref?: string;
  homeLabel?: string;
  /** Next.js error digest — shown small for support. */
  digest?: string;
  size?: "sm" | "md" | "lg";
}

/** Something went wrong — with a way out. */
export function ErrorState({
  title = "Something went wrong",
  message = "We couldn't load this. Please try again, and if it keeps happening let your administrator know.",
  onRetry,
  retryLabel = "Try again",
  homeHref,
  homeLabel = "Go home",
  digest,
  size = "md",
  className,
  ...props
}: ErrorStateProps) {
  const pad = { sm: "py-8 px-4", md: "py-14 px-6", lg: "py-20 px-8" }[size];

  return (
    <div
      role="alert"
      className={cn("flex flex-col items-center justify-center text-center", pad, className)}
      {...props}
    >
      <div className="mb-4 flex size-11 items-center justify-center rounded-full bg-danger-soft text-danger ring-1 ring-inset ring-danger/15">
        <TriangleAlert aria-hidden="true" className="size-5" />
      </div>
      <h3 className="text-md font-semibold text-ink">{title}</h3>
      {message ? <p className="mt-1 max-w-md text-sm text-ink-muted">{message}</p> : null}
      {onRetry || homeHref ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {onRetry ? (
            <Button variant="primary" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
          {homeHref ? (
            <Button variant="outline" href={homeHref}>
              {homeLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
      {digest ? (
        <p className="mt-4 font-mono text-2xs text-ink-subtle">Reference: {digest}</p>
      ) : null}
    </div>
  );
}
