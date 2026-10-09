"use client";

import * as React from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Plus, Tag } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { api } from "@/lib/api-client";
import { DEFAULT_JOB_TYPES } from "@/lib/constants";
import type { JobTypeView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ColourField } from "./colour-field";
import { useConflict } from "./use-conflict";

export interface JobTypesManagerProps {
  jobTypes: JobTypeView[];
  workflows: { id: string; name: string; isDefault: boolean }[];
  canManage: boolean;
  defaultEstimatedHours: number;
  timeZone: string;
}

const TYPE_PALETTE = Array.from(new Set(DEFAULT_JOB_TYPES.map((t) => t.colour)));

function JobTypeDialog({
  open,
  onOpenChange,
  jobType,
  workflows,
  defaultEstimatedHours,
  onConflict,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  jobType: JobTypeView | null;
  workflows: JobTypesManagerProps["workflows"];
  defaultEstimatedHours: number;
  onConflict: ReturnType<typeof useConflict>["onConflict"];
}) {
  const run = useMutationRunner();
  const defaultWorkflow = workflows.find((w) => w.isDefault)?.id ?? workflows[0]?.id ?? "";
  const [name, setName] = React.useState(jobType?.name ?? "");
  const [colour, setColour] = React.useState(jobType?.colour ?? TYPE_PALETTE[0]);
  const [workflowId, setWorkflowId] = React.useState(jobType?.workflow.id ?? defaultWorkflow);
  const [hours, setHours] = React.useState(jobType?.defaultEstimatedHours == null ? "" : String(jobType.defaultEstimatedHours));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const workflowChanged = jobType !== null && workflowId !== jobType.workflow.id;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    const h = hours.trim() === "" ? null : Number(hours);
    if (h !== null && (Number.isNaN(h) || h < 0 || h > 500)) {
      setErrors({ defaultEstimatedHours: "Enter hours between 0 and 500, or leave blank" });
      return;
    }
    setPending(true);
    const res = jobType
      ? await run(
          () =>
            api.patch(`/api/job-types/${jobType.id}`, {
              expectedVersion: jobType.version,
              name: name.trim(),
              colour,
              workflowId: workflowChanged ? workflowId : undefined,
              defaultEstimatedHours: h,
            }),
          {
            success: "Job type updated",
            onConflict: (err) => {
              onOpenChange(false);
              onConflict(err);
            },
          },
        )
      : await run(() => api.post("/api/job-types", { name: name.trim(), colour, workflowId: workflowId || undefined, defaultEstimatedHours: h }), {
          success: `Job type “${name.trim()}” created`,
        });
    setPending(false);
    if (res.ok) onOpenChange(false);
    else if (res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (pending ? undefined : onOpenChange(o))} size="md">
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
        <DialogHeader>
          <DialogTitle>{jobType ? `Edit ${jobType.name}` : "New job type"}</DialogTitle>
          <DialogDescription>Job types pick the workflow a new job follows and its default workload estimate.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-4">
          <FormField label="Name" required error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} placeholder="Twilight" />
          </FormField>
          <FormField label="Colour" error={errors.colour}>
            <ColourField value={colour} onChange={setColour} palette={TYPE_PALETTE} label="Job type colour" />
          </FormField>
          <FormField
            label="Workflow"
            description={workflowChanged ? "Only new jobs use the new workflow — existing jobs keep the one they started with." : "Statuses and transitions jobs of this type follow."}
            error={errors.workflowId}
          >
            <Select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.isDefault ? " (default)" : ""}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Default estimated hours"
            optional
            description={`Feeds editor workload scores. Blank = studio default (${defaultEstimatedHours} h).`}
            error={errors.defaultEstimatedHours}
          >
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={500}
              step="0.5"
              value={hours}
              placeholder={String(defaultEstimatedHours)}
              onChange={(e) => setHours(e.target.value)}
              trailing={<span className="text-xs">h</span>}
              className="numeric"
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {jobType ? "Save" : "Create job type"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export function JobTypesManager({ jobTypes, workflows, canManage, defaultEstimatedHours, timeZone }: JobTypesManagerProps) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("job type", timeZone);
  const [editing, setEditing] = React.useState<JobTypeView | "new" | null>(null);
  const [archiving, setArchiving] = React.useState<JobTypeView | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const live = jobTypes.filter((t) => t.archivedAt === null);
  const archived = jobTypes.filter((t) => t.archivedAt !== null);
  const rows = showArchived ? [...live, ...archived] : live;

  const restore = async (t: JobTypeView) => {
    await run(() => api.post(`/api/job-types/${t.id}/restore`, { expectedVersion: t.version }), { success: `${t.name} restored`, onConflict });
  };

  const menu = (t: JobTypeView) =>
    canManage ? (
      <DropdownMenu>
        <DropdownMenuTrigger variant="ghost" size="icon" aria-label={`${t.name} actions`}>
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width="11rem">
          {t.archivedAt === null ? (
            <>
              <DropdownMenuItem icon={<Pencil />} onSelect={() => setEditing(t)}>
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<Archive />} destructive onSelect={() => setArchiving(t)}>
                Archive
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem icon={<ArchiveRestore />} onSelect={() => restore(t)}>
              Restore
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {archived.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setShowArchived((s) => !s)} aria-pressed={showArchived}>
            {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
          </Button>
        ) : (
          <span />
        )}
        {canManage ? (
          <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setEditing("new")}>
            New job type
          </Button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Tag}
            title="No job types yet"
            description="Add the kinds of work you do — Real Estate, Wedding, Drone, Floor Plans — each with its workflow and typical hours."
            action={
              canManage ? (
                <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setEditing("new")}>
                  Create a job type
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <Card flush className="hidden overflow-hidden md:flex">
            <Table density="default">
              <THead>
                <tr>
                  <TH>Job type</TH>
                  <TH>Workflow</TH>
                  <TH numeric>Default hours</TH>
                  <TH numeric>Open jobs</TH>
                  <TH shrink>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {rows.map((t) => (
                  <TR key={t.id} className={cn(t.archivedAt && "opacity-60")}>
                    <TD primary>
                      <button type="button" disabled={!canManage || t.archivedAt !== null} onClick={() => setEditing(t)} className="flex items-center gap-2.5 rounded-xs text-left focus-ring disabled:cursor-default">
                        <span aria-hidden="true" className="size-3 rounded-sm" style={{ backgroundColor: t.colour }} />
                        {t.name}
                        {t.archivedAt ? (
                          <Badge variant="outline" size="sm">
                            Archived
                          </Badge>
                        ) : null}
                      </button>
                    </TD>
                    <TD>
                      <Link href={`/settings/workflows/${t.workflow.id}`} className="text-ink-secondary hover:text-accent-ink hover:underline">
                        {t.workflow.name}
                      </Link>
                    </TD>
                    <TD numeric>
                      {t.defaultEstimatedHours === null ? <span className="text-ink-subtle">{defaultEstimatedHours} (default)</span> : `${t.defaultEstimatedHours} h`}
                    </TD>
                    <TD numeric muted={t.openJobCount === 0}>
                      {t.openJobCount}
                    </TD>
                    <TD>{menu(t)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
          <ul className="flex flex-col gap-2 md:hidden">
            {rows.map((t) => (
              <li key={t.id} className={cn("flex items-center gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-xs", t.archivedAt && "opacity-60")}>
                <span aria-hidden="true" className="size-8 shrink-0 rounded-md" style={{ backgroundColor: t.colour }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{t.name}</p>
                  <p className="truncate text-xs text-ink-muted">
                    {t.workflow.name} · <span className="numeric">{t.defaultEstimatedHours ?? defaultEstimatedHours} h</span> ·{" "}
                    <span className="numeric">{t.openJobCount} open</span>
                  </p>
                </div>
                {menu(t)}
              </li>
            ))}
          </ul>
        </>
      )}

      {editing ? (
        <JobTypeDialog
          key={editing === "new" ? "new" : editing.id}
          open
          onOpenChange={(o) => !o && setEditing(null)}
          jobType={editing === "new" ? null : editing}
          workflows={workflows}
          defaultEstimatedHours={defaultEstimatedHours}
          onConflict={onConflict}
        />
      ) : null}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={`Archive ${archiving?.name ?? "job type"}?`}
        description={
          archiving && archiving.openJobCount > 0
            ? `${archiving.openJobCount} open jobs keep this type, but it can't be picked for new jobs. You can restore it later.`
            : "It can't be picked for new jobs. Past jobs keep it, and you can restore it later."
        }
        confirmLabel="Archive"
        destructive
        onConfirm={async () => {
          if (!archiving) return true;
          const res = await run(() => api.post(`/api/job-types/${archiving.id}/archive`, { expectedVersion: archiving.version }), {
            success: `${archiving.name} archived`,
            onConflict,
          });
          return res.ok || res.handled;
        }}
      />
      {dialog}
    </div>
  );
}
