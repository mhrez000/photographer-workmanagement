"use client";

import * as React from "react";
import { Info, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { readStorage, writeStorage } from "@/lib/utils";

const STORAGE_KEY = "proofline.editors.onTimeNoteDismissed";

const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** Dismissed on this browser (server snapshot: treated as dismissed, so nothing flashes before hydration). */
function getSnapshot(): boolean {
  return readStorage(STORAGE_KEY) !== null;
}
function getServerSnapshot(): boolean {
  return true;
}

/**
 * One-time note about the new meaning of "On time" (docs/SIMPLIFICATION-PLAN.md §7): it is now measured
 * when the editor sends the job for checking, not when you approve it. A per-viewer convenience, so the
 * dismissal lives in the browser.
 */
export function OnTimeNote() {
  const dismissed = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (dismissed) return null;

  const dismiss = () => {
    writeStorage(STORAGE_KEY, new Date().toISOString());
    for (const listener of listeners) listener();
  };

  return (
    <div role="note" className="flex items-start gap-3 rounded-md border border-info/25 bg-info-soft/60 px-4 py-3 text-sm text-ink">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">&ldquo;On time&rdquo; now means the editor sent the job for checking by its due date.</span>{" "}
        <span className="text-ink-secondary">The time you take to check never counts against them, so these numbers may differ from the old reports.</span>
      </p>
      <IconButton label="Dismiss" variant="ghost" size="sm" onClick={dismiss} className="-mr-1 -mt-1 shrink-0">
        <X aria-hidden="true" />
      </IconButton>
    </div>
  );
}
