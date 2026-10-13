"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { STALE_PAGE_MESSAGE } from "@/components/jobs/mutation";
import { toast } from "@/components/ui/toast";
import type { ApiError } from "@/lib/api-client";

/**
 * Stale-page handler for the simplified job actions (docs/SIMPLIFICATION-PLAN.md §9 "the 'someone else
 * just changed this job' protection"): a 409, or a 403 because the job moved on ("This job is now with
 * Sam. Nothing to do here."), means the buttons on screen belong to an older version of the job. The
 * answer is router.refresh() + ONE toast — never a dialog, never an error that blames the viewer. The
 * ConflictDialog stays for edits (EditJobSimpleForm), which never come through here.
 *
 *   const { onConflict, conflictDialog } = useConflict(timeZone);
 *   await run(() => simpleJobApi.approve(id, body), { success: "Approved", onConflict });
 *   return <>{…}{conflictDialog}</>;
 *
 * `conflictDialog` is kept (now empty) so the islands' markup does not change.
 */
export function useConflict(timeZone?: string) {
  void timeZone; // was the dialog's date format; kept so the islands' call sites need not change
  const router = useRouter();
  const onConflict = React.useCallback(
    (err: ApiError) => {
      router.refresh();
      toast.info(STALE_PAGE_MESSAGE, err.isConflict ? undefined : err.message);
    },
    [router],
  );
  const conflictDialog: React.ReactNode = null;
  return { onConflict, conflictDialog };
}
