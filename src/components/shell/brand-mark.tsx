import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export interface BrandMarkProps extends React.ComponentPropsWithRef<"svg"> {
  size?: number;
}

/**
 * Proofline logo mark: a teal tile with an open aperture ring and a
 * centre point — "the shot, and the proof of it".
 */
export function BrandMark({ size = 28, className, ...props }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={cn("shrink-0 text-accent", className)}
      {...props}
    >
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <circle
        cx="16"
        cy="16"
        r="8.5"
        stroke="var(--accent-fg)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeDasharray="40 13.4"
        transform="rotate(-54 16 16)"
      />
      <circle cx="16" cy="16" r="2.7" fill="var(--accent-fg)" />
      <circle cx="24.2" cy="8.2" r="1.6" fill="var(--accent-fg)" opacity="0.85" />
    </svg>
  );
}

export interface BrandProps {
  /** Hide the wordmark (collapsed sidebar). */
  compact?: boolean;
  /** Secondary line under the wordmark, e.g. the organisation name. */
  subtitle?: React.ReactNode;
  href?: string;
  className?: string;
}

/** Mark + "Proofline" wordmark, optionally linking home. */
export function Brand({ compact = false, subtitle, href = "/dashboard", className }: BrandProps) {
  const content = (
    <>
      <BrandMark size={28} />
      {!compact ? (
        <span className="flex min-w-0 flex-col leading-none">
          <span className="truncate text-[15px] font-semibold tracking-tight text-ink">Proofline</span>
          {subtitle ? (
            <span className="mt-1 truncate text-2xs font-medium uppercase tracking-wider text-ink-muted">
              {subtitle}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );

  return (
    <Link
      href={href}
      aria-label={compact ? "Proofline — Dashboard" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-sm focus-ring",
        compact && "justify-center",
        className,
      )}
    >
      {content}
    </Link>
  );
}
