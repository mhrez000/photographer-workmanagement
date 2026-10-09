"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";
import { ApiError, errorMessage } from "@/lib/api-client";

/**
 * Shared mutation plumbing for client islands:
 *   success → toast.success + router.refresh()
 *   409     → `onConflict` (ConflictDialog) or a toast with a Reload action
 *   400     → field errors handed back to the form
 *   other   → toast.error(errorMessage(err))
 */

export type FieldErrors = Record<string, string[]>;

/** What a dialog's submit handler resolves to: close (true), stay open (false), or show field errors. */
export type DialogSubmitResult = boolean | { fieldErrors: FieldErrors };

export type MutationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: unknown; fieldErrors: FieldErrors | null; handled: boolean };

export interface RunMutationOptions {
  /** Toast shown on success (omit for silent). */
  success?: string;
  successDescription?: string;
  /** Called with the 409 error; when omitted a toast with "Reload" is shown. */
  onConflict?: (error: ApiError) => void;
  /** Return true when the error was handled (no toast). Runs before the defaults. */
  onError?: (error: ApiError) => boolean;
  /** Skip router.refresh() on success. */
  noRefresh?: boolean;
}

/** First message per field, for FormField `error` props. */
export function firstFieldErrors(errors: FieldErrors | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!errors) return out;
  for (const [key, messages] of Object.entries(errors)) if (messages?.[0]) out[key] = messages[0];
  return out;
}

/** Converts a mutation result into the value a dialog's onSubmit should return. */
export function toDialogResult(result: MutationResult<unknown>): DialogSubmitResult {
  if (result.ok) return true;
  if (result.fieldErrors && Object.keys(result.fieldErrors).length > 0) return { fieldErrors: result.fieldErrors };
  // Conflicts / handled errors close the form so the follow-up dialog is visible.
  return result.handled;
}

/** Hook returning `run(fn, options)`, bound to the router for refreshes. */
export function useMutationRunner() {
  const router = useRouter();

  return React.useCallback(
    async <T,>(fn: () => Promise<T>, options: RunMutationOptions = {}): Promise<MutationResult<T>> => {
      try {
        const data = await fn();
        if (options.success) toast.success(options.success, options.successDescription);
        if (!options.noRefresh) router.refresh();
        return { ok: true, data };
      } catch (err) {
        if (!(err instanceof ApiError)) {
          toast.error(errorMessage(err));
          return { ok: false, error: err, fieldErrors: null, handled: false };
        }
        if (options.onError?.(err)) return { ok: false, error: err, fieldErrors: null, handled: true };
        if (err.isConflict) {
          if (options.onConflict) {
            options.onConflict(err);
          } else {
            toast({
              title: "Someone else changed this just now",
              description: "Your change was not saved. Reload to see the latest version.",
              variant: "warning",
              duration: 0,
              action: { label: "Reload", onClick: () => router.refresh() },
            });
          }
          return { ok: false, error: err, fieldErrors: null, handled: true };
        }
        const fieldErrors = err.code === "validation" ? err.fieldErrors : {};
        if (Object.keys(fieldErrors).length > 0) {
          return { ok: false, error: err, fieldErrors, handled: false };
        }
        toast.error(errorMessage(err));
        return { ok: false, error: err, fieldErrors: null, handled: false };
      }
    },
    [router],
  );
}
