"use client";

import * as React from "react";
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
import { DEFAULT_JOB_TYPES, DEFAULT_USUAL_DAYS_TO_EDIT } from "@/lib/constants";
import type { JobTypeView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ColourField } from "./colour-field";
import { useConflict } from "./use-conflict";

/** A type of shoot with its "usual days to edit" (plan §5: due date = shoot date + N). */
export type ShootTypeRow = JobTypeView & { usualDaysToEdit: number | null };

export interface ShootTypesManagerProps {
  shootTypes: ShootTypeRow[];
  /** Advanced only: the workflow a type follows. */
  workflows: { id: string; name: string; isDefault: boolean }[];
  canManage: boolean;
  /** Settings → Studio → Advanced tools (plan §8): shows workflow and estimated hours. */
  advanced: boolean;
  defaultEstimatedHours: number;
  timeZone: string;
}

const TYPE_PALETTE = Array.from(new Set(DEFAULT_JOB_TYPES.map((t) => t.colour)));

function daysLabel(n: number | null): string {
  const d = n ?? DEFAULT_USUAL_DAYS_TO_EDIT;
  return d === 0 ? "Same day" : d === 1 ? "Next day" : `${d} days`;
}

function ShootTypeDialog({
  open,
  onOpenChange,
  shootType,
  workflows,
  advanced,
  defaultEstimatedHours,
  onConflict,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  shootType: ShootTypeRow | null;
  workflows: ShootTypesManagerProps["workflows"];
  advanced: boolean;
  defaultEstimatedHours: number;
  onConflict: ReturnType<typeof useConflict>["onConflict"];
}) {
  const run = useMutationRunner();
  const defaultWorkflow = workflows.find((w) => w.isDefault)?.id ?? workflows[0]?.id ?? "";
  const [name, setName] = React.useState(shootType?.name ?? "");
  const [colour, setColour] = React.useState(shootType?.colour ?? TYPE_PALETTE[0]);
  const [days, setDays] = React.useState(shootType?.usualDaysToEdit == null ? String(DEFAULT_USUAL_DAYS_TO_EDIT) : String(shootType.usualDaysToEdit));
  const [workflowId, setWorkflowId] = React.useState(shootType?.workflow.id ?? defaultWorkflow);
  const [hours, setHours] = React.useState(shootType?.defaultEstimatedHours == null ? "" : String(shootType.defaultEstimatedHours));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const workflowChanged = shootType !== null && workflowId !== shootType.workflow.id;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    const d = days.trim() === "" ? null : Number(days);
    if (d !== null && (!Number.isInteger(d) || d < 0 || d > 365)) {
      setErrors({ usualDaysToEdit: "Enter a whole number of days from 0 to 365" });
      return;
    }
    const h = hours.trim() === "" ? null : Number(hours);
    if (advanced && h !== null && (Number.isNaN(h) || h < 0 || h > 500)) {
      setErrors({ defaultEstimatedHours: "Enter hours between 0 and 500, or leave blank" });
      return;
    }
    setPending(true);
    const advancedFields = advanced ? { workflowId: shootType ? (workflowChanged ? workflowId : undefined) : workflowId || undefined, defaultEstimatedHours: h } : {};
    const res = shootType
      ? await run(
          () => api.patch(`/api/job-types/${shootType.id}`, { expectedVersion: shootType.version, name: name.trim(), colour, usualDaysToEdit: d, ...advancedFields }),
          {
            success: "Type of shoot saved",
            onConflict: (err) => {
              onOpenChange(false);
              onConflict(err);
            },
          },
        )
      : await run(() => api.post("/api/job-types", { name: name.trim(), colour, usualDaysToEdit: d, ...advancedFields }), {
          success: `“${name.trim()}” added`,
        });
    setPending(false);
    if (res.ok) onOpenChange(false);
    else if (res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (pending ? undefined : onOpenChange(o))} size="md">
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
        <DialogHeader>
          <DialogTitle>{shootType ? `Edit ${shootType.name}` : "New type of shoot"}</DialogTitle>
          <DialogDescription>A name, a colour, and how many days editing usually takes. The New job form uses the days to suggest a due date.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-4">
          <FormField label="Name" required error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} placeholder="Twilight" />
          </FormField>
          <FormField label="Colour" error={errors.colour}>
            <ColourField value={colour} onChange={setColour} palette={TYPE_PALETTE} label="Colour" />
          </FormField>
          <FormField
            label="Usual days to edit"
            description="Due date = shoot date + this many days. 0 means the same day."
            error={errors.usualDaysToEdit}
          >
            <Input type="number" inputMode="numeric" min={0} max={365} step="1" value={days} onChange={(e) => setDays(e.target.value)} trailing={<span className="text-xs">days</span>} className="numeric" />
          </FormField>
          {advanced ? (
            <div className="flex flex-col gap-4 rounded-lg border border-border p-3.5">
              <p className="flex items-center gap-2 text-sm font-medium text-ink">
                Advanced
                <Badge variant="outline" size="sm">
                  Advanced tools
                </Badge>
              </p>
              <FormField
                label="Workflow"
                description={workflowChanged ? "Only new jobs use the new workflow — existing jobs keep the one they started with." : "The statuses jobs of this type follow."}
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
              <FormField label="Estimated hours" optional description={`Blank = studio default (${defaultEstimatedHours} h).`} error={errors.defaultEstimatedHours}>
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
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {shootType ? "Save" : "Add type of shoot"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Settings → Types of shoot (plan §8 "Kept"): name, colour and usual days to edit. */
export function ShootTypesManager({ shootTypes, workflows, canManage, advanced, defaultEstimatedHours, timeZone }: ShootTypesManagerProps) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("type of shoot", timeZone);
  const [editing, setEditing] = React.useState<ShootTypeRow | "new" | null>(null);
  const [archiving, setArchiving] = React.useState<ShootTypeRow | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const live = shootTypes.filter((t) => t.archivedAt === null);
  const archived = shootTypes.filter((t) => t.archivedAt !== null);
  const rows = showArchived ? [...live, ...archived] : live;

  const restore = async (t: ShootTypeRow) => {
    await run(() => api.post(`/api/job-types/${t.id}/restore`, { expectedVersion: t.version }), { success: `${t.name} restored`, onConflict });
  };

  const menu = (t: ShootTypeRow) =>
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
          <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setEditing("new")} data-new-shoot-type="">
            New type of shoot
          </Button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Tag}
            title="No types of shoot yet"
            description="Add the kinds of shoot you do — Real estate, Twilight, Drone, Floor plans — each with its usual days to edit."
            action={
              canManage ? (
                <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setEditing("new")}>
                  Add a type of shoot
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
                  <TH>Type of shoot</TH>
                  <TH>Usual days to edit</TH>
                  {advanced ? <TH>Workflow</TH> : null}
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
                      <button
                        type="button"
                        disabled={!canManage || t.archivedAt !== null}
                        onClick={() => setEditing(t)}
                        className="flex items-center gap-2.5 rounded-xs text-left focus-ring disabled:cursor-default"
                      >
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
                      <span className="text-ink">{daysLabel(t.usualDaysToEdit)}</span>
                      {t.usualDaysToEdit === null ? <span className="ml-1.5 text-2xs text-ink-subtle">default</span> : null}
                    </TD>
                    {advanced ? <TD muted>{t.workflow.name}</TD> : null}
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
                    {daysLabel(t.usualDaysToEdit)} to edit · <span className="numeric">{t.openJobCount} open</span>
                  </p>
                </div>
                {menu(t)}
              </li>
            ))}
          </ul>
        </>
      )}

      {editing ? (
        <ShootTypeDialog
          key={editing === "new" ? "new" : editing.id}
          open
          onOpenChange={(o) => !o && setEditing(null)}
          shootType={editing === "new" ? null : editing}
          workflows={workflows}
          advanced={advanced}
          defaultEstimatedHours={defaultEstimatedHours}
          onConflict={onConflict}
        />
      ) : null}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={`Archive ${archiving?.name ?? "this type"}?`}
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
