"use client";

import * as React from "react";
import { ArrowRight, CircleAlert, Inbox, UserRoundCheck } from "lucide-react";
import { DueChip, JobLink, StatusPill, useMutationRunner, useUserOptions, WorkloadBand } from "@/components/jobs";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { SearchInput } from "@/components/ui/search-input";
import { Sheet, SheetBody, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api-client";
import { CATEGORY_GROUPS, STATUS_CATEGORY_META } from "@/lib/constants";
import type { BulkResult, JobRow, UserRef } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";

export interface ReassignDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The editor whose jobs are being moved (often deactivated). */
  from: UserRef;
  timeZone: string;
}

/** Bulk-reassigns an editor's open jobs to one picked editor (POST /api/jobs/bulk/reassign). */
export function ReassignDrawer({ open, onOpenChange, from, timeZone }: ReassignDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} side="right" size="lg">
      {open ? <ReassignBody from={from} timeZone={timeZone} onClose={() => onOpenChange(false)} /> : null}
    </Sheet>
  );
}

type JobsState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; jobs: JobRow[] };

function ReassignBody({ from, timeZone, onClose }: { from: UserRef; timeZone: string; onClose: () => void }) {
  const run = useMutationRunner();
  const [state, setState] = React.useState<JobsState>({ status: "loading" });
  const [nonce, setNonce] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [target, setTarget] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [reason, setReason] = React.useState(from.isActive ? "" : `${from.name} is no longer active`);
  const [submitting, setSubmitting] = React.useState(false);
  const [failures, setFailures] = React.useState<BulkResult["failed"]>([]);
  const people = useUserOptions("editor");

  React.useEffect(() => {
    const controller = new AbortController();
    api
      .get<{ rows: JobRow[] }>("/api/jobs", { query: { editorId: from.id, limit: 200 }, signal: controller.signal })
      .then((res) => {
        const open = (res?.rows ?? []).filter((j) => CATEGORY_GROUPS.ACTIVE.includes(j.statusCategory));
        setState({ status: "ready", jobs: open });
        // Pre-select what the editor is actually holding (editing or waiting in review).
        setSelected(new Set(open.filter((j) => CATEGORY_GROUPS.WORKLOAD.includes(j.statusCategory)).map((j) => j.id)));
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ status: "error", message: errorMessage(err) });
      });
    return () => controller.abort();
  }, [from.id, nonce]);

  const jobs = state.status === "ready" ? state.jobs : [];
  const candidates = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const rank = { healthy: 0, near_capacity: 1, overloaded: 2 } as const;
    return people.options
      .filter((o) => o.id !== from.id && o.isActive && (!q || o.name.toLowerCase().includes(q)))
      .sort((a, b) => (a.band ? rank[a.band] : 1) - (b.band ? rank[b.band] : 1) || (a.activeJobs ?? 0) - (b.activeJobs ?? 0) || a.name.localeCompare(b.name));
  }, [people.options, query, from.id]);
  const targetUser = people.options.find((o) => o.id === target) ?? null;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allChecked = jobs.length > 0 && jobs.every((j) => selected.has(j.id));

  const submit = async () => {
    if (!target || selected.size === 0) return;
    setSubmitting(true);
    setFailures([]);
    const result = await run(() => api.post<BulkResult>("/api/jobs/bulk/reassign", { jobIds: [...selected], userId: target, reason: reason.trim() || null }), {});
    setSubmitting(false);
    if (!result.ok) return;
    const { ok, failed } = result.data;
    if (ok.length > 0) toast.success(`${pluralise(ok.length, "job")} moved to ${targetUser?.name ?? "the new editor"}`);
    if (failed.length > 0) {
      setFailures(failed);
      setSelected(new Set(failed.map((f) => f.id)));
      setNonce((n) => n + 1);
      toast({ title: `${pluralise(failed.length, "job")} couldn't be moved`, description: "See the reasons in the drawer.", variant: "warning" });
    } else {
      onClose();
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>Reassign {from.name.split(" ")[0]}&apos;s jobs</SheetTitle>
        <SheetDescription>
          {from.isActive
            ? "Move open jobs to another editor to rebalance the load. Each move is recorded in the job's history."
            : `${from.name} is deactivated. Move their open jobs to an active editor so nothing stalls.`}
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-6">
        <section aria-labelledby="reassign-jobs" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 id="reassign-jobs" className="text-sm font-semibold text-ink">
              1. Jobs to move
            </h3>
            {jobs.length > 0 ? (
              <Checkbox
                size="sm"
                checked={allChecked}
                indeterminate={!allChecked && selected.size > 0}
                onChange={() => setSelected(allChecked ? new Set() : new Set(jobs.map((j) => j.id)))}
                label={<span className="text-xs text-ink-muted">Select all</span>}
              />
            ) : null}
          </div>
          {state.status === "loading" ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : state.status === "error" ? (
            <ErrorState size="sm" title="Couldn't load their jobs" message={state.message} onRetry={() => setNonce((n) => n + 1)} />
          ) : jobs.length === 0 ? (
            <EmptyState icon={Inbox} size="sm" title="No open jobs" description={`${from.name} isn't holding anything right now.`} bordered />
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {jobs.map((j) => {
                const failed = failures.find((f) => f.id === j.id);
                return (
                  <li key={j.id} className={cn("flex items-start gap-3 px-3 py-2.5", failed && "bg-danger-soft/40")}>
                    <Checkbox checked={selected.has(j.id)} onChange={() => toggle(j.id)} aria-label={`Move ${j.jobNumber}`} className="mt-0.5" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <JobLink job={j} />
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusPill status={j.status} size="xs" />
                        <DueChip due={j.dueDate} timeZone={timeZone} done={STATUS_CATEGORY_META[j.statusCategory].done} compact />
                      </div>
                      {failed ? (
                        <p className="flex items-center gap-1 text-xs text-danger-fg">
                          <CircleAlert aria-hidden="true" className="size-3.5" />
                          {failed.message}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="reassign-to" className="flex flex-col gap-2">
          <h3 id="reassign-to" className="text-sm font-semibold text-ink">
            2. New editor
          </h3>
          <SearchInput value={query} onValueChange={setQuery} placeholder="Find an editor…" aria-label="Find an editor" />
          {people.loading ? (
            <Skeleton className="h-32 w-full" />
          ) : people.error ? (
            <ErrorState size="sm" title="Couldn't load editors" message={people.error} onRetry={people.reload} />
          ) : candidates.length === 0 ? (
            <p className="px-1 py-3 text-sm text-ink-muted">No active editors match.</p>
          ) : (
            <div role="radiogroup" aria-label="New editor" className="flex max-h-72 flex-col overflow-y-auto rounded-md border border-border scrollbar-thin">
              {candidates.map((o) => {
                const checked = target === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    onClick={() => setTarget(o.id)}
                    className={cn(
                      "flex items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 focus-ring-inset",
                      checked ? "bg-accent-soft/60" : "hover:bg-surface-muted/60",
                    )}
                  >
                    <Avatar name={o.name} colour={o.avatarColour || undefined} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{o.name}</span>
                    {o.activeJobs !== null ? <span className="text-xs text-ink-muted numeric">{pluralise(o.activeJobs, "active job")}</span> : null}
                    {o.band ? <WorkloadBand band={o.band} showLabel={false} /> : null}
                    {checked ? <UserRoundCheck aria-hidden="true" className="size-4 text-accent" /> : null}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <FormField label="Reason" optional hint="Shown in each job's history and the new editor's notification.">
          <Textarea value={reason} onChange={(e) => setReason(e.currentTarget.value)} rows={2} maxLength={2000} />
        </FormField>
      </SheetBody>
      <SheetFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} loading={submitting} disabled={!target || selected.size === 0} trailingIcon={<ArrowRight aria-hidden="true" />}>
          {selected.size === 0 ? "Select jobs" : !target ? "Pick an editor" : `Move ${pluralise(selected.size, "job")}`}
        </Button>
      </SheetFooter>
    </>
  );
}
