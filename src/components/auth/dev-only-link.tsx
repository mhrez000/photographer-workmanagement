"use client";

import { FlaskConical } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";

export interface DevOnlyLinkProps {
  /** What the link does, e.g. "Reset link". */
  label: string;
  url: string;
}

/**
 * Local development without an email provider: the API returns the one-time link so it can be
 * copied straight from the screen (never in production, where the field is simply absent).
 */
export function DevOnlyLink({ label, url }: DevOnlyLinkProps) {
  return (
    <section aria-labelledby="dev-only-link" className="rounded-lg border border-dashed border-attention/40 bg-attention-soft/40 p-4">
      <div className="flex items-center gap-2">
        <FlaskConical aria-hidden="true" className="size-4 text-attention" />
        <h2 id="dev-only-link" className="text-sm font-semibold text-ink">
          Development only
        </h2>
      </div>
      <p className="mt-1 text-xs text-ink-muted">Email isn&apos;t set up on this computer, so here is the {label.toLowerCase()} instead.</p>
      <div className="mt-3 flex items-start gap-2">
        <a href={url} className="min-w-0 flex-1 break-all font-mono text-xs text-accent-ink underline-offset-4 hover:underline">
          {url}
        </a>
        <CopyButton value={url} ariaLabel={`Copy ${label.toLowerCase()}`} variant="outline" />
      </div>
    </section>
  );
}
