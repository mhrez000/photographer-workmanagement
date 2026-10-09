"use client";

import * as React from "react";
import { ConflictDialog } from "@/components/jobs/conflict-dialog";
import type { ApiError } from "@/lib/api-client";

/**
 * Conflict (409) plumbing for settings forms: `onConflict` goes into
 * `run(…, { onConflict })`, `dialog` is rendered once by the component.
 * The dialog refreshes the page so the form shows the latest version.
 */
export function useConflict(entity: string, timeZone?: string) {
  const [error, setError] = React.useState<ApiError | null>(null);
  const onConflict = React.useCallback((err: ApiError) => setError(err), []);
  const dialog = (
    <ConflictDialog
      open={error !== null}
      onOpenChange={(open) => {
        if (!open) setError(null);
      }}
      error={error ?? undefined}
      entity={entity}
      timeZone={timeZone}
    />
  );
  return { onConflict, dialog };
}
