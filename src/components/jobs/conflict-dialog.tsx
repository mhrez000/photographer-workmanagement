"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { GitCompareArrows, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api-client";
import { STATUS_CATEGORY_META, type StatusCategory } from "@/lib/constants";
import { formatDateTime, formatRelative } from "@/lib/dates";

export interface ConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The 409 ApiError — `error.current` (the row as it is now) is summarised when present. */
  error?: unknown;
  /** "job", "revision", "view"… used in the copy. */
  entity?: string;
  /** Org timezone for "updated at". */
  timeZone?: string;
  /** Extra work after the refresh (e.g. re-open an editor). */
  onReload?: () => void;
}

interface CurrentSummary {
  name: string | null;
  status: string | null;
  editor: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  version: number | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function nameOf(v: unknown): string | null {
  return v && typeof v === "object" ? str((v as { name?: unknown }).name) : null;
}

/** Pulls the human-relevant bits out of `err.current` without trusting its shape. */
function summarise(current: unknown): CurrentSummary | null {
  if (!current || typeof current !== "object") return null;
  const c = current as Record<string, unknown>;
  const job = (c.job && typeof c.job === "object" ? c.job : c) as Record<string, unknown>;
  const category = str(job.statusCategory);
  const status =
    nameOf(job.status) ??
    str(job.statusName) ??
    (category && category in STATUS_CATEGORY_META ? STATUS_CATEGORY_META[category as StatusCategory].label : null);
  return {
    name: str(job.name),
    status,
    editor: nameOf(job.editor),
    updatedAt: str(job.updatedAt) ?? str(job.lastActivityAt),
    updatedBy: nameOf(job.updatedBy) ?? nameOf(c.actor) ?? str(c.actorName),
    version: typeof job.version === "number" ? job.version : null,
  };
}

/**
 * Optimistic-concurrency conflict (409): someone else changed the record
 * after this page loaded. Explains what happened, shows the current state
 * when the server sent it, and reloads the latest data.
 */
export function ConflictDialog({ open, onOpenChange, error, entity = "job", timeZone, onReload }: ConflictDialogProps) {
  const router = useRouter();
  const summary = error instanceof ApiError ? summarise(error.current) : null;

  const reload = () => {
    router.refresh();
    onOpenChange(false);
    onReload?.();
  };

  const rows: [string, string][] = [];
  if (summary?.status) rows.push(["Status now", summary.status]);
  if (summary?.editor) rows.push(["Editor now", summary.editor]);
  if (summary?.updatedBy) rows.push(["Changed by", summary.updatedBy]);
  if (summary?.updatedAt) rows.push(["Changed", `${formatRelative(summary.updatedAt)} · ${formatDateTime(summary.updatedAt, timeZone)}`]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm">
      <DialogHeader>
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-attention-soft text-attention ring-1 ring-inset ring-attention/20">
          <GitCompareArrows aria-hidden="true" className="size-5" />
        </div>
        <DialogTitle>This {entity} just changed</DialogTitle>
        <DialogDescription>
          Someone else updated {summary?.name ? <strong className="font-medium text-ink">{summary.name}</strong> : `this ${entity}`} after
          you opened it, so your change was not saved. Reload to see the latest version, then try again.
        </DialogDescription>
      </DialogHeader>
      {rows.length > 0 ? (
        <DialogBody className="pb-4">
          <dl className="divide-y divide-border rounded-md border border-border bg-surface-sunken text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 px-3 py-2">
                <dt className="text-ink-muted">{label}</dt>
                <dd className="text-right text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </DialogBody>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
        <Button variant="primary" leadingIcon={<RefreshCw />} onClick={reload} autoFocus>
          Reload latest
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
