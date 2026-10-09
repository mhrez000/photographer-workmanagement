"use client";

import * as React from "react";
import { KeyRound, ShieldAlert } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";

/** Shows a one-time temporary password with a copy button and a clear warning. */
export function TempPasswordPanel({ name, email, password }: { name: string; email?: string | null; password: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-surface-sunken p-4">
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <KeyRound aria-hidden="true" className="size-4" />
          Temporary password for <span className="font-medium text-ink">{name}</span>
          {email ? <span className="truncate">· {email}</span> : null}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
          <code className="select-all break-all font-mono text-md tracking-wide text-ink" aria-label="Temporary password">
            {password}
          </code>
          <CopyButton value={password} label="Copy" successMessage="Password copied" variant="outline" />
        </div>
      </div>
      <p className="flex items-start gap-2 text-sm text-ink-muted">
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-attention" />
        This is shown once and never stored in readable form. Share it privately — they should change it from Profile after signing in.
      </p>
    </div>
  );
}
