"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, CircleAlert, CircleCheck, Flag, Search, UserMinus, UserRoundPen, X } from "lucide-react";
import { useUserOptions, type UserOption } from "@/components/jobs/use-user-options";
import { WorkloadBand } from "@/components/jobs/workload-band";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api-client";
import { PRIORITIES, PRIORITY_META, STATUS_CATEGORY_META, type StatusCategory } from "@/lib/constants";
import type { BulkResult, JobRow } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";

/** Bulk-transition targets: categories reachable without a per-job payload (revision needs instructions, resubmitted goes through the revision). */
const BULK_TARGETS: readonly StatusCategory[] = ["ready", "assigned", "accepted", "in_progress", "submitted", "review", "approved", "delivered", "completed", "cancelled"];
const MAX_BULK = 200;

export interface BulkActionsProps {
  selected: JobRow[];
  onClear: () => void;
  /** Keep only these ids selected (failed jobs stay selected so they can be retried). */
  onKeep: (ids: string[]) => void;
  canOverride: boolean;
}

type Outcome = { action: string; result: BulkResult };

/** Floating bar for the selected rows: reassign editor, set priority, change status. */
export function BulkActions({ selected, onClear, onKeep, canOverride }: BulkActionsProps) {
  const router = useRouter();
  const [dialog, setDialog] = React.useState<"reassign" | "status" | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);
  const labels = React.useMemo(() => new Map(selected.map((r) => [r.id, `${r.jobNumber} · ${r.name}`])), [selected]);
  const count = selected.length;
  const tooMany = count > MAX_BULK;

  /** Posts a bulk request; returns true to close the calling dialog. */
  const submit = async (path: string, body: Record<string, unknown>, action: string): Promise<boolean | { fieldErrors: Record<string, string[]> }> => {
    setBusy(true);
    try {
      const result = await api.post<BulkResult>(path, { ...body, jobIds: selected.map((r) => r.id) });
      router.refresh();
      if (result.failed.length === 0) {
        toast.success(`${action}: ${pluralise(result.ok.length, "job")} updated`);
        onClear();
      } else {
        onKeep(result.failed.map((f) => f.id));
        setOutcome({ action, result });
      }
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation" && Object.keys(err.fieldErrors).length > 0) {
        return { fieldErrors: err.fieldErrors };
      }
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (count === 0 && !outcome) return null;

  return (
    <>
      {count > 0 ? (
        <div className="pointer-events-none sticky bottom-4 z-30 flex justify-center px-2" role="region" aria-label="Bulk actions">
          <div className="pointer-events-auto flex max-w-full animate-slide-up flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface-raised p-1.5 pl-3 shadow-pop">
            <span className="mr-1 text-sm font-medium text-ink numeric" aria-live="polite">
              {pluralise(count, "job")} selected
            </span>
            {tooMany ? <span className="text-xs text-danger-fg">Max {MAX_BULK} at once</span> : null}
            <Button size="sm" variant="ghost" leadingIcon={<UserRoundPen aria-hidden="true" />} onClick={() => setDialog("reassign")} disabled={busy || tooMany}>
              Reassign
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger size="sm" variant="ghost" leadingIcon={<Flag aria-hidden="true" />} disabled={busy || tooMany}>
                Priority
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" aria-label="Set priority" width="11rem">
                <DropdownMenuLabel>Set priority</DropdownMenuLabel>
                {PRIORITIES.map((p) => (
                  <DropdownMenuItem
                    key={p}
                    icon={<span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: PRIORITY_META[p].hex }} />}
                    onSelect={() => void submit("/api/jobs/bulk/priority", { priority: p }, `Priority set to ${PRIORITY_META[p].label}`)}
                  >
                    {PRIORITY_META[p].label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="ghost" leadingIcon={<ArrowRightLeft aria-hidden="true" />} onClick={() => setDialog("status")} disabled={busy || tooMany}>
              Status
            </Button>
            <Button size="sm" variant="ghost" onClick={onClear} leadingIcon={<X aria-hidden="true" />} aria-label="Clear selection" loading={busy}>
              <span className="hidden sm:inline">Clear</span>
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={dialog === "reassign"} onOpenChange={(o) => setDialog(o ? "reassign" : null)} size="md">
        <BulkReassignForm
          count={count}
          onCancel={() => setDialog(null)}
          onSubmit={async (userId, reason) => {
            const done = await submit("/api/jobs/bulk/reassign", { userId, reason }, userId ? "Reassigned" : "Unassigned");
            if (done === true) setDialog(null);
            return done;
          }}
        />
      </Dialog>

      <Dialog open={dialog === "status"} onOpenChange={(o) => setDialog(o ? "status" : null)} size="sm">
        <BulkStatusForm
          count={count}
          canOverride={canOverride}
          onCancel={() => setDialog(null)}
          onSubmit={async (toCategory, reason, override) => {
            const done = await submit(
              "/api/jobs/bulk/transition",
              { toCategory, reason: reason || null, override: override || undefined },
              `Moved to ${STATUS_CATEGORY_META[toCategory].label}`,
            );
            if (done === true) setDialog(null);
            return done;
          }}
        />
      </Dialog>

      <Dialog open={outcome !== null} onOpenChange={(o) => !o && setOutcome(null)} size="md">
        {outcome ? <BulkOutcome outcome={outcome} labels={labels} onClose={() => setOutcome(null)} /> : null}
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */

function firstError(result: boolean | { fieldErrors: Record<string, string[]> }): string | null {
  if (typeof result === "object") return Object.values(result.fieldErrors)[0]?.[0] ?? "Check the form and try again.";
  return null;
}

function BulkReassignForm({
  count,
  onCancel,
  onSubmit,
}: {
  count: number;
  onCancel: () => void;
  onSubmit: (userId: string | null, reason: string | null) => Promise<boolean | { fieldErrors: Record<string, string[]> }>;
}) {
  const people = useUserOptions("editor");
  const [query, setQuery] = React.useState("");
  const [choice, setChoice] = React.useState<string | null>(null); // user id | "__none__"
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const bandRank = { healthy: 0, near_capacity: 1, overloaded: 2 } as const;
    return people.options
      .filter((o) => !q || o.name.toLowerCase().includes(q))
      .sort((a, b) => (a.band ? bandRank[a.band] : 3) - (b.band ? bandRank[b.band] : 3) || (a.activeJobs ?? 0) - (b.activeJobs ?? 0) || a.name.localeCompare(b.name));
  }, [people.options, query]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (choice === null) return;
    setSubmitting(true);
    setError(null);
    const result = await onSubmit(choice === "__none__" ? null : choice, reason.trim() || null);
    setSubmitting(false);
    setError(firstError(result));
  };

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>Reassign {pluralise(count, "job")}</DialogTitle>
        <DialogDescription>Each job is reassigned on its own; any that cannot move are listed afterwards. Workload bands show who has room.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 pb-5">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search editors…"
          leading={<Search aria-hidden="true" />}
          aria-label="Search editors"
          autoFocus
        />
        <div role="radiogroup" aria-label="Choose editor" className="-mx-1 max-h-[min(20rem,45dvh)] space-y-1 overflow-y-auto px-1 scrollbar-thin">
          {people.loading ? (
            Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12 w-full rounded-md" />)
          ) : people.error ? (
            <p className="rounded-md border border-danger/25 bg-danger-soft/60 px-3 py-2 text-sm text-danger-fg">
              {people.error}{" "}
              <button type="button" className="underline underline-offset-2 focus-ring" onClick={people.reload}>
                Try again
              </button>
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-ink-muted">{query ? `No editors match “${query}”.` : "There are no active editors yet."}</p>
          ) : (
            filtered.map((o) => <EditorOption key={o.id} option={o} selected={choice === o.id} onSelect={() => setChoice(o.id)} />)
          )}
          <button
            type="button"
            role="radio"
            aria-checked={choice === "__none__"}
            onClick={() => setChoice("__none__")}
            className={cn(
              "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors focus-ring",
              choice === "__none__" ? "border-danger/40 bg-danger-soft/60 text-danger-fg" : "border-dashed border-border text-ink-secondary hover:bg-surface-muted",
            )}
          >
            <UserMinus aria-hidden="true" className="size-4" />
            <span className="flex-1">Unassign the editor</span>
            <span className="text-xs text-ink-subtle">Jobs go back to Ready</span>
          </button>
        </div>
        <FormField label="Reason" optional description="Recorded in each job's history.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} placeholder="e.g. Rebalancing the week" />
        </FormField>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant={choice === "__none__" ? "danger" : "primary"} loading={submitting} disabled={choice === null}>
          {choice === "__none__" ? `Unassign ${pluralise(count, "job")}` : `Reassign ${pluralise(count, "job")}`}
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditorOption({ option, selected, onSelect }: { option: UserOption; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors focus-ring",
        selected ? "border-accent bg-accent-soft/60" : "border-transparent hover:bg-surface-muted",
      )}
    >
      <Avatar name={option.name} size="md" colour={option.avatarColour || undefined} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{option.name}</span>
        {option.activeJobs !== null ? <span className="text-xs text-ink-muted numeric">{option.activeJobs} active</span> : null}
      </span>
      {option.band ? <WorkloadBand band={option.band} ratio={option.ratio} size="sm" /> : null}
    </button>
  );
}

function BulkStatusForm({
  count,
  canOverride,
  onCancel,
  onSubmit,
}: {
  count: number;
  canOverride: boolean;
  onCancel: () => void;
  onSubmit: (toCategory: StatusCategory, reason: string, override: boolean) => Promise<boolean | { fieldErrors: Record<string, string[]> }>;
}) {
  const [target, setTarget] = React.useState<StatusCategory | "">("");
  const [reason, setReason] = React.useState("");
  const [override, setOverride] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const needsReason = target === "cancelled" || override;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!target) return;
    if (needsReason && !reason.trim()) {
      setError(target === "cancelled" ? "Give a reason for cancelling." : "Overrides need a reason.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await onSubmit(target, reason.trim(), override);
    setSubmitting(false);
    setError(firstError(result));
  };

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>Change status of {pluralise(count, "job")}</DialogTitle>
        <DialogDescription>Each job follows its own workflow. Jobs that cannot make the move are skipped and listed afterwards.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 pb-5">
        <FormField label="Move to" required>
          <Select
            value={target}
            onChange={(e) => setTarget(e.target.value as StatusCategory | "")}
            placeholder="Choose a stage…"
            options={BULK_TARGETS.map((c) => ({ value: c, label: STATUS_CATEGORY_META[c].label }))}
          />
        </FormField>
        <FormField label="Reason" required={needsReason} optional={!needsReason} description="Recorded in each job's history.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} />
        </FormField>
        {canOverride ? (
          <Checkbox
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
            label="Override workflow rules"
            description="Allow moves the workflow does not offer. Audited as an override."
          />
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant={target === "cancelled" ? "danger" : "primary"} loading={submitting} disabled={!target}>
          Move {pluralise(count, "job")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function BulkOutcome({ outcome, labels, onClose }: { outcome: Outcome; labels: Map<string, string>; onClose: () => void }) {
  const { ok, failed } = outcome.result;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{outcome.action}</DialogTitle>
        <DialogDescription>
          {ok.length > 0 ? `${pluralise(ok.length, "job")} updated. ` : ""}
          {pluralise(failed.length, "job")} could not be changed and {failed.length === 1 ? "is" : "are"} still selected.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-3 pb-5">
        {ok.length > 0 ? (
          <p className="flex items-center gap-2 rounded-md bg-success-soft/60 px-3 py-2 text-sm text-success-fg">
            <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
            <span className="numeric">{pluralise(ok.length, "job")} done</span>
          </p>
        ) : null}
        <ul className="max-h-[min(20rem,50dvh)] divide-y divide-border overflow-y-auto rounded-md border border-border scrollbar-thin" aria-label="Jobs that failed">
          {failed.map((f) => (
            <li key={f.id} className="flex items-start gap-2.5 px-3 py-2.5">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink">{labels.get(f.id) ?? f.id}</span>
                <span className="block text-sm text-ink-muted">{f.message}</span>
              </span>
            </li>
          ))}
        </ul>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}

