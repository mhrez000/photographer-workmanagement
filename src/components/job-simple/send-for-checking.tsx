"use client";

import * as React from "react";
import { Send } from "lucide-react";
import { useMutationRunner, firstFieldErrors } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import type { ApiError } from "@/lib/api-client";
import type { SimpleLink } from "@/lib/types";
import { isAllowedLinkUrl } from "@/lib/validation/links";
import { cn } from "@/lib/utils";
import { simpleJobApi } from "./api";

export interface SendForCheckingFormProps {
  jobId: string;
  version: number;
  /** The latest finished link (pre-fills the box after changes were asked). */
  lastLink: SimpleLink | null;
  /** A finished link is current on the job: offers "I updated the same link". */
  hasCurrentLink: boolean;
  /** Who checks it ("Mo") — for the helper line. */
  checkerName?: string | null;
  onConflict?: (error: ApiError) => void;
  onDone?: () => void;
  /** Tighter spacing (cards). */
  compact?: boolean;
  autoFocus?: boolean;
  className?: string;
}

/** "drive.google.com/folder/x" (a host with a dot and a TLD, optionally a path) typed without the scheme. */
const BARE_HOST = /^[\w.-]+\.[a-z]{2,}(?:[/?#]|$)/i;

/** Adds https:// to a link copied without its scheme; anything else is returned as typed. */
export function normaliseLinkUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return BARE_HOST.test(trimmed) ? `https://${trimmed}` : trimmed;
}

/**
 * The "Finished photos link" box + [Send for checking] (plan §5). The button
 * stays off until a link is filled in (any http(s) link counts, a shared-drive
 * folder included); a link pasted without "https://" gets it added rather than
 * bounced; "I updated the same link" keeps the current one.
 */
export function SendForCheckingForm({ jobId, version, lastLink, hasCurrentLink, checkerName, onConflict, onDone, compact = false, autoFocus = false, className }: SendForCheckingFormProps) {
  const run = useMutationRunner();
  const [url, setUrl] = React.useState(lastLink?.url ?? "");
  const [sameLink, setSameLink] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const trimmed = url.trim();
  const ready = sameLink ? hasCurrentLink : trimmed.length > 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    const normalised = normaliseLinkUrl(trimmed);
    if (!sameLink && !isAllowedLinkUrl(normalised)) {
      setError("That doesn't look like a link. Paste the full address, like drive.google.com/… or https://…");
      return;
    }
    if (!sameLink && normalised !== trimmed) setUrl(normalised);
    setBusy(true);
    setError(null);
    const result = await run(
      () =>
        simpleJobApi.sendForChecking(jobId, {
          expectedVersion: version,
          finishedLink: sameLink ? { reuseCurrent: true } : { url: normalised },
        }),
      { success: "Sent for checking", successDescription: checkerName ? `${checkerName} will be told.` : undefined, onConflict },
    );
    setBusy(false);
    if (result.ok) onDone?.();
    else if (result.fieldErrors) {
      const f = firstFieldErrors(result.fieldErrors);
      setError(f.finishedLink ?? f["finishedLink.url"] ?? Object.values(f)[0] ?? "Please check the link.");
    }
  };

  return (
    <form onSubmit={submit} noValidate className={cn("flex flex-col", compact ? "gap-2" : "gap-3", className)}>
      <FormField label="Finished photos link" required error={error ?? undefined} description={compact ? undefined : "A gallery, a shared-drive folder or a download link — any link works."}>
        <Input
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (error) setError(null);
          }}
          onBlur={() => {
            const n = normaliseLinkUrl(url);
            if (n !== url.trim() && n) setUrl(n);
          }}
          placeholder="https://"
          disabled={busy || sameLink}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {hasCurrentLink ? (
          <Checkbox size="sm" checked={sameLink} onChange={(e) => setSameLink(e.target.checked)} label={<span className="text-sm">I updated the same link</span>} disabled={busy} />
        ) : (
          <span />
        )}
        <Button type="submit" leadingIcon={<Send aria-hidden="true" />} loading={busy} disabled={!ready} className={compact ? "" : "sm:min-w-44"}>
          Send for checking
        </Button>
      </div>
    </form>
  );
}

export interface SendForCheckingDialogProps extends Omit<SendForCheckingFormProps, "compact" | "autoFocus" | "className"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobLabel?: string;
  /** Shown above the box — the quoted request after changes were asked (the pinned phone card). */
  intro?: React.ReactNode;
}

/**
 * The same box in a dialog, for the [Send for checking] button on a My jobs card and for the
 * pinned next-step bar on phones (plan §5), where the box would otherwise take half the screen.
 */
export function SendForCheckingDialog({ open, onOpenChange, jobLabel, intro, onDone, ...form }: SendForCheckingDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm">
      {open ? (
        <>
          <DialogHeader>
            <DialogTitle>Send for checking</DialogTitle>
            <DialogDescription>{jobLabel ? <span className="font-medium text-ink-secondary">{jobLabel}. </span> : null}Paste where the finished photos are.</DialogDescription>
          </DialogHeader>
          <DialogBody className="pb-5">
            {intro ? <div className="mb-4">{intro}</div> : null}
            <SendForCheckingForm
              {...form}
              autoFocus
              onDone={() => {
                onOpenChange(false);
                onDone?.();
              }}
            />
          </DialogBody>
        </>
      ) : null}
    </Dialog>
  );
}
