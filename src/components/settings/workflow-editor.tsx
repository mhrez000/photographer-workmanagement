"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, CircleAlert, CircleCheck, Flag, GripVertical, Lock, Pencil, Plus, ShieldCheck, Star, UserCheck, Undo2 } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SectionCard } from "@/components/common/section-card";
import { useMutationRunner } from "@/components/jobs/mutation";
import { CategoryPill, StatusPill, statusColour } from "@/components/jobs/status-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { api, type ApiError } from "@/lib/api-client";
import { ROLE_LABELS, type Role } from "@/lib/constants";
import type { WorkflowGraph, WorkflowStatusView, WorkflowTransitionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CATEGORY_MEANING } from "./category-meaning";
import { useConflict } from "./use-conflict";
import { StatusDialog } from "./workflow-status-dialog";
import { TransitionDialog, type TransitionDraft } from "./workflow-transition-dialog";

export interface WorkflowEditorProps {
  graph: WorkflowGraph;
  canManage: boolean;
  timeZone: string;
}

const ROLE_INITIAL: Record<Role, string> = { owner: "O", manager: "M", photographer: "P", editor: "E" };

/* ------------------------------------------------------------------ */
/*  Header: rename, default, archive                                   */
/* ------------------------------------------------------------------ */

function WorkflowDetailsDialog({ open, onOpenChange, graph }: { open: boolean; onOpenChange: (o: boolean) => void; graph: WorkflowGraph }) {
  const run = useMutationRunner();
  const w = graph.workflow;
  const [name, setName] = React.useState(w.name);
  const [description, setDescription] = React.useState(w.description ?? "");
  const [error, setError] = React.useState<string | undefined>();
  const [pending, setPending] = React.useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    const res = await run(() => api.patch(`/api/workflows/${w.id}`, { expectedVersion: w.version, name: name.trim(), description: description.trim() || null }), {
      success: "Workflow updated",
    });
    setPending(false);
    if (res.ok) onOpenChange(false);
    else if (res.fieldErrors) setError(res.fieldErrors.name?.[0]);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (pending ? undefined : onOpenChange(o))} size="sm">
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col" noValidate>
        <DialogHeader>
          <DialogTitle>Rename workflow</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-4">
          <FormField label="Name" required error={error}>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
          </FormField>
          <FormField label="Description" optional>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={1000} />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export function WorkflowHeaderActions({ graph, canManage }: { graph: WorkflowGraph; canManage: boolean }) {
  const router = useRouter();
  const run = useMutationRunner();
  const [renaming, setRenaming] = React.useState(false);
  const [confirm, setConfirm] = React.useState<"default" | "archive" | null>(null);
  const w = graph.workflow;
  if (!canManage || w.archivedAt) return null;
  return (
    <>
      <Button variant="outline" size="sm" leadingIcon={<Pencil aria-hidden="true" />} onClick={() => setRenaming(true)}>
        Rename
      </Button>
      {!w.isDefault ? (
        <Button variant="outline" size="sm" leadingIcon={<Star aria-hidden="true" />} onClick={() => setConfirm("default")}>
          Make default
        </Button>
      ) : null}
      {!w.isDefault ? (
        <Button variant="ghost" size="sm" leadingIcon={<Archive aria-hidden="true" />} onClick={() => setConfirm("archive")}>
          Archive
        </Button>
      ) : null}
      {renaming ? <WorkflowDetailsDialog open onOpenChange={setRenaming} graph={graph} /> : null}
      <ConfirmDialog
        open={confirm === "default"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Make “${w.name}” the default?`}
        description="New job types use the default workflow unless you choose another. Existing jobs and job types are unchanged."
        confirmLabel="Make default"
        onConfirm={async () => {
          const res = await run(() => api.patch(`/api/workflows/${w.id}`, { expectedVersion: w.version, isDefault: true }), { success: "Default workflow changed" });
          return res.ok || res.handled;
        }}
      />
      <ConfirmDialog
        open={confirm === "archive"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Archive “${w.name}”?`}
        description={
          w.jobTypes.length > 0
            ? `Rebind ${w.jobTypes.map((t) => t.name).join(", ")} to another workflow first.`
            : w.openJobCount > 0
              ? `${w.openJobCount} open jobs still use it; they keep working, but no new jobs can use it.`
              : "It can no longer be chosen for job types. History is kept."
        }
        confirmLabel="Archive workflow"
        destructive
        onConfirm={async () => {
          const res = await run(() => api.post(`/api/workflows/${w.id}/archive`, { expectedVersion: w.version }), { success: "Workflow archived", noRefresh: true });
          if (res.ok) router.push("/settings/workflows");
          return res.ok || res.handled;
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Statuses (sortable)                                                */
/* ------------------------------------------------------------------ */

function StatusRow({
  status,
  sortable,
  canManage,
  onEdit,
  onArchive,
}: {
  status: WorkflowStatusView;
  sortable: boolean;
  canManage: boolean;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: status.id, disabled: !sortable });
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  const blocked = status.jobCount > 0;
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative flex items-center gap-3 bg-surface px-3 py-2.5 sm:px-4",
        isDragging && "z-10 rounded-md shadow-pop ring-1 ring-border-strong",
      )}
    >
      {sortable ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${status.name}`}
          className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted hover:text-ink active:cursor-grabbing focus-ring"
        >
          <GripVertical aria-hidden="true" className="size-4" />
        </button>
      ) : (
        <span aria-hidden="true" className="w-1" />
      )}
      <span aria-hidden="true" className="size-3 shrink-0 rounded-full ring-2 ring-surface" style={{ backgroundColor: statusColour(status) }} />
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 rounded-xs text-left focus-ring">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-ink">{status.name}</span>
          {status.isInitial ? (
            <Badge variant="accent" size="sm">
              Initial
            </Badge>
          ) : null}
          <code className="hidden font-mono text-2xs text-ink-subtle sm:inline">{status.key}</code>
        </span>
        {status.description ? <span className="mt-0.5 block truncate text-xs text-ink-muted">{status.description}</span> : null}
      </button>
      <Tooltip content={CATEGORY_MEANING[status.category]} side="top">
        <span tabIndex={0} className="hidden rounded-full focus-ring sm:inline-flex">
          <CategoryPill category={status.category} size="sm" />
        </span>
      </Tooltip>
      <span className={cn("w-16 shrink-0 text-right text-xs numeric", status.jobCount > 0 ? "text-ink-secondary" : "text-ink-subtle")} title="Jobs currently in this status">
        {status.jobCount} {status.jobCount === 1 ? "job" : "jobs"}
      </span>
      {canManage ? (
        <div className="flex shrink-0 items-center">
          <IconButton label={`Edit ${status.name}`} size="sm" onClick={onEdit}>
            <Pencil />
          </IconButton>
          <Tooltip content={blocked ? `${status.jobCount} jobs sit here — move them first` : status.isInitial ? "Make another status initial first" : "Archive status"}>
            <span>
              <IconButton label={`Archive ${status.name}`} size="sm" onClick={onArchive} disabled={blocked || status.isInitial}>
                <Archive />
              </IconButton>
            </span>
          </Tooltip>
        </div>
      ) : null}
    </li>
  );
}

function StatusesSection({ graph, canManage, onConflict }: { graph: WorkflowGraph; canManage: boolean; onConflict: (e: ApiError) => void }) {
  const run = useMutationRunner();
  const dndId = React.useId();
  const live = React.useMemo(() => graph.statuses.filter((s) => s.archivedAt === null), [graph.statuses]);
  const archived = graph.statuses.filter((s) => s.archivedAt !== null);
  const serverOrder = live.map((s) => s.id).join(",");
  const [order, setOrder] = React.useState<string[]>(() => live.map((s) => s.id));
  const [syncedOrder, setSyncedOrder] = React.useState(serverOrder);
  const [editing, setEditing] = React.useState<WorkflowStatusView | "new" | null>(null);
  const [archiving, setArchiving] = React.useState<WorkflowStatusView | null>(null);
  const [saving, setSaving] = React.useState(false);

  if (serverOrder !== syncedOrder) {
    setSyncedOrder(serverOrder);
    setOrder(live.map((s) => s.id));
  }

  const byId = new Map(live.map((s) => [s.id, s]));
  const ordered = order.map((id) => byId.get(id)).filter((s): s is WorkflowStatusView => Boolean(s));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const sortable = canManage && !graph.workflow.archivedAt && !saving;

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const previous = order;
    const next = arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id)));
    setOrder(next);
    setSaving(true);
    const res = await run(() => api.post(`/api/workflows/${graph.workflow.id}/reorder`, { statusIds: next }), { success: "Order saved" });
    setSaving(false);
    if (!res.ok) setOrder(previous);
  };

  return (
    <SectionCard
      id="statuses"
      title="Statuses"
      description={canManage ? "Drag to reorder. Order sets kanban order within a column and the default target when moving by category." : "In workflow order."}
      actions={
        canManage && !graph.workflow.archivedAt ? (
          <Button size="sm" variant="outline" leadingIcon={<Plus aria-hidden="true" />} onClick={() => setEditing("new")}>
            Add status
          </Button>
        ) : undefined
      }
      flush
    >
      <DndContext id={dndId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <ol className={cn("divide-y divide-border", saving && "opacity-80")} aria-busy={saving}>
            {ordered.map((s) => (
              <StatusRow key={s.id} status={s} sortable={sortable} canManage={canManage && !graph.workflow.archivedAt} onEdit={() => setEditing(s)} onArchive={() => setArchiving(s)} />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {archived.length > 0 ? (
        <details className="group border-t border-border">
          <summary className="cursor-pointer list-none px-4 py-2.5 text-sm text-ink-muted hover:text-ink focus-ring-inset">
            {archived.length} archived {archived.length === 1 ? "status" : "statuses"} <span className="text-ink-subtle">(kept for history)</span>
          </summary>
          <ul className="flex flex-wrap gap-2 px-4 pb-3">
            {archived.map((s) => (
              <li key={s.id}>
                <StatusPill status={s} size="sm" className="opacity-60" />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {editing ? (
        <StatusDialog
          key={editing === "new" ? "new" : editing.id}
          open
          onOpenChange={(o) => !o && setEditing(null)}
          workflowId={graph.workflow.id}
          status={editing === "new" ? null : editing}
          readOnly={!canManage || Boolean(graph.workflow.archivedAt)}
          onConflict={onConflict}
        />
      ) : null}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={`Archive “${archiving?.name ?? ""}”?`}
        description="Jobs can no longer enter it and its transitions stop being offered. Past history keeps showing it."
        confirmLabel="Archive status"
        destructive
        onConfirm={async () => {
          if (!archiving) return true;
          const res = await run(() => api.post(`/api/statuses/${archiving.id}/archive`, { expectedVersion: archiving.version }), {
            success: "Status archived",
            onConflict,
          });
          return res.ok || res.handled;
        }}
      />
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Transitions matrix                                                 */
/* ------------------------------------------------------------------ */

function EdgeChip({ edge }: { edge: WorkflowTransitionView }) {
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="flex gap-0.5">
        {(["owner", "manager", "photographer", "editor"] as const).map((r) => (
          <span
            key={r}
            title={ROLE_LABELS[r]}
            className={cn(
              "flex size-4 items-center justify-center rounded-xs text-[9px] font-semibold leading-none",
              edge.allowedRoles.includes(r) ? "bg-accent-soft text-accent-ink" : "text-ink-subtle/50",
            )}
          >
            {ROLE_INITIAL[r]}
          </span>
        ))}
      </span>
      <span className="flex gap-1 text-ink-muted">
        {edge.assigneeOnly ? <UserCheck aria-label="Assigned editor only" className="size-3" /> : null}
        {edge.requiresAssignedEditor ? <ShieldCheck aria-label="Requires an editor" className="size-3" /> : null}
        {edge.isReopen ? <Undo2 aria-label="Reopen" className="size-3" /> : null}
        {edge.generated ? <Flag aria-label="Generated cancel edge" className="size-3 text-ink-subtle" /> : null}
      </span>
    </span>
  );
}

function edgeLabel(edge: WorkflowTransitionView, from?: WorkflowStatusView, to?: WorkflowStatusView): string {
  const parts = [`${from?.name ?? "?"} → ${to?.name ?? "?"}`];
  if (edge.label) parts.push(`“${edge.label}”`);
  parts.push(edge.allowedRoles.map((r) => ROLE_LABELS[r]).join(", "));
  if (edge.assigneeOnly) parts.push("assigned editor only");
  if (edge.requiresAssignedEditor) parts.push("needs an editor");
  if (edge.isReopen) parts.push("reopen");
  if (edge.generated) parts.push("generated");
  return parts.join(" · ");
}

function TransitionsSection({ graph, canManage }: { graph: WorkflowGraph; canManage: boolean }) {
  const [view, setView] = React.useState<"matrix" | "list">("matrix");
  const [selected, setSelected] = React.useState<{ transition: WorkflowTransitionView | null; draft: TransitionDraft | null } | null>(null);
  const live = graph.statuses.filter((s) => s.archivedAt === null);
  const byId = new Map(graph.statuses.map((s) => [s.id, s]));
  const edges = graph.transitions.filter((t) => t.archivedAt === null);
  const edgeAt = new Map(edges.map((e) => [`${e.fromStatusId}->${e.toStatusId}`, e]));
  const editable = canManage && !graph.workflow.archivedAt;
  const storedCount = edges.filter((e) => !e.generated).length;

  return (
    <SectionCard
      id="transitions"
      title="Transitions"
      description={`${storedCount} transitions${edges.length > storedCount ? ` + ${edges.length - storedCount} generated cancel edges` : ""}. Rows are “from”, columns are “to”.`}
      actions={
        <div className="flex items-center gap-2">
          <SegmentedControl
            size="sm"
            aria-label="Transitions view"
            value={view}
            onValueChange={setView}
            options={[
              { value: "matrix", label: "Matrix" },
              { value: "list", label: "List" },
            ]}
            className="hidden md:inline-flex"
          />
          {editable ? (
            <Button size="sm" variant="outline" leadingIcon={<Plus aria-hidden="true" />} onClick={() => setSelected({ transition: null, draft: null })}>
              Add
            </Button>
          ) : null}
        </div>
      }
      flush
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-5 py-2 text-2xs text-ink-muted">
        <span>
          <span className="font-semibold text-accent-ink">O M P E</span> allowed roles
        </span>
        <span className="inline-flex items-center gap-1">
          <UserCheck aria-hidden="true" className="size-3" /> assigned editor only
        </span>
        <span className="inline-flex items-center gap-1">
          <ShieldCheck aria-hidden="true" className="size-3" /> needs an editor
        </span>
        <span className="inline-flex items-center gap-1">
          <Undo2 aria-hidden="true" className="size-3" /> reopen
        </span>
        <span className="inline-flex items-center gap-1">
          <Flag aria-hidden="true" className="size-3" /> generated cancel
        </span>
      </div>

      {/* Matrix (md+) */}
      <div className={cn("overflow-auto scrollbar-thin", view === "matrix" ? "hidden md:block" : "hidden")} style={{ maxHeight: "70vh" }}>
        <table className="border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 top-0 z-20 min-w-40 border-b border-r border-border bg-surface-sunken px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                From ↓ / To →
              </th>
              {live.map((to) => (
                <th key={to.id} scope="col" className="sticky top-0 z-10 border-b border-border bg-surface-sunken px-1.5 py-2 align-bottom">
                  <span className="flex w-16 flex-col items-center gap-1 text-center font-medium text-ink-secondary">
                    <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: statusColour(to) }} />
                    <span className="line-clamp-2 leading-tight">{to.name}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {live.map((from) => (
              <tr key={from.id}>
                <th scope="row" className="sticky left-0 z-10 border-b border-r border-border bg-surface px-3 py-1.5 text-left font-medium text-ink">
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: statusColour(from) }} />
                    <span className="truncate">{from.name}</span>
                  </span>
                </th>
                {live.map((to) => {
                  if (from.id === to.id) {
                    return <td key={to.id} className="border-b border-border bg-surface-sunken/70" aria-hidden="true" />;
                  }
                  const edge = edgeAt.get(`${from.id}->${to.id}`);
                  const label = edge ? edgeLabel(edge, from, to) : `${from.name} → ${to.name}: no transition`;
                  return (
                    <td key={to.id} className="border-b border-border p-0.5">
                      {edge ? (
                        <button
                          type="button"
                          title={label}
                          aria-label={label}
                          onClick={() => setSelected({ transition: edge, draft: null })}
                          className={cn(
                            "flex h-11 w-16 items-center justify-center rounded-sm transition-colors duration-(--motion-fast) focus-ring",
                            edge.generated ? "border border-dashed border-border-strong hover:bg-surface-muted" : "bg-accent-soft/40 hover:bg-accent-soft",
                          )}
                        >
                          <EdgeChip edge={edge} />
                        </button>
                      ) : editable ? (
                        <button
                          type="button"
                          aria-label={`Add transition ${from.name} → ${to.name}`}
                          onClick={() => setSelected({ transition: null, draft: { fromStatusId: from.id, toStatusId: to.id } })}
                          className="group flex h-11 w-16 items-center justify-center rounded-sm text-ink-subtle/0 hover:bg-surface-muted hover:text-ink-subtle focus-ring focus:text-ink-subtle"
                        >
                          <Plus aria-hidden="true" className="size-3.5" />
                        </button>
                      ) : (
                        <span className="block h-11 w-16" />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* List (mobile, or chosen) */}
      <ul className={cn("divide-y divide-border", view === "matrix" && "md:hidden")}>
        {live.map((from) => {
          const out = edges.filter((e) => e.fromStatusId === from.id);
          return (
            <li key={from.id} className="px-4 py-3 sm:px-5">
              <div className="mb-2">
                <StatusPill status={from} size="sm" />
              </div>
              {out.length === 0 ? (
                <p className="text-xs text-ink-subtle">No outgoing transitions{from.category === "completed" || from.category === "cancelled" ? " (terminal)" : ""}.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {out.map((e) => {
                    const to = byId.get(e.toStatusId);
                    return (
                      <li key={`${e.id}-${e.toStatusId}`}>
                        <button
                          type="button"
                          onClick={() => setSelected({ transition: e, draft: null })}
                          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-muted focus-ring"
                        >
                          <span className="text-ink-subtle">→</span>
                          <span className="min-w-0 flex-1 truncate text-ink">
                            {to?.name ?? "?"}
                            {e.label ? <span className="text-ink-muted"> · {e.label}</span> : null}
                          </span>
                          <span className="shrink-0 font-mono text-2xs text-ink-muted">{e.allowedRoles.map((r) => ROLE_INITIAL[r]).join(" ")}</span>
                          {e.generated ? <Flag aria-label="Generated" className="size-3 shrink-0 text-ink-subtle" /> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {selected ? (
        <TransitionDialog
          key={selected.transition ? `${selected.transition.id}-${selected.transition.toStatusId}` : `${selected.draft?.fromStatusId}-${selected.draft?.toStatusId}`}
          open
          onOpenChange={(o) => !o && setSelected(null)}
          workflowId={graph.workflow.id}
          statuses={graph.statuses}
          transition={selected.transition}
          draft={selected.draft}
          readOnly={!editable}
        />
      ) : null}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Validation                                                         */
/* ------------------------------------------------------------------ */

function ValidationPanel({ problems }: { problems: string[] }) {
  if (problems.length === 0) {
    return (
      <div role="status" className="flex items-center gap-3 rounded-lg border border-success/25 bg-success-soft/60 px-4 py-3 text-sm text-success-fg">
        <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
        Workflow is valid: one initial status, every required category, every status reachable and every open status has a way forward.
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-lg border border-danger/25 bg-danger-soft/60 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-medium text-danger-fg">
        <CircleAlert aria-hidden="true" className="size-4" />
        {problems.length} {problems.length === 1 ? "problem" : "problems"} to fix before this workflow is safe to use
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-danger-fg">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function WorkflowEditor({ graph, canManage, timeZone }: WorkflowEditorProps) {
  const { onConflict, dialog } = useConflict("status", timeZone);
  return (
    <div className="flex flex-col gap-6">
      {!canManage ? (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-sm text-ink-secondary">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          <p>Read-only: only an owner can change workflows.</p>
        </div>
      ) : null}
      <ValidationPanel problems={graph.validation} />
      <StatusesSection graph={graph} canManage={canManage} onConflict={onConflict} />
      <TransitionsSection graph={graph} canManage={canManage} />
      {dialog}
    </div>
  );
}
