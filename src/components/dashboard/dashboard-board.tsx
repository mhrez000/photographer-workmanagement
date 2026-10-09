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
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EyeOff, GripVertical, LayoutDashboard, Plus, RotateCcw, Settings2 } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ConflictDialog } from "@/components/jobs/conflict-dialog";
import { useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { toast } from "@/components/ui/toast";
import { api, type ApiError } from "@/lib/api-client";
import type { DashboardWidgetType } from "@/lib/constants";
import type { DashboardData } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WIDGET_META, WIDGET_WIDTHS, widgetSpanClass } from "./widget-meta";

export type DashboardWidget = DashboardData["layout"]["widgets"][number];

/** Reading order of a stored layout: top-to-bottom, then left-to-right. */
export function orderWidgets(widgets: readonly DashboardWidget[]): DashboardWidget[] {
  return [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Re-flows widgets (in the given order) into a 12-column grid so x/y match what the user sees. */
export function packWidgets(widgets: readonly DashboardWidget[]): DashboardWidget[] {
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return widgets.map((w) => {
    const width = Math.min(Math.max(w.w, 1), 12);
    if (x + width > 12) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    const placed = { ...w, w: width, x, y };
    x += width;
    rowHeight = Math.max(rowHeight, w.h);
    return placed;
  });
}

/** The closest offered width for a stored width. */
function nearestWidth(width: number): number {
  return WIDGET_WIDTHS.reduce<number>((best, o) => (Math.abs(o.value - width) < Math.abs(best - width) ? o.value : best), WIDGET_WIDTHS[0].value);
}

const sameLayout = (a: readonly DashboardWidget[], b: readonly DashboardWidget[]) =>
  a.length === b.length && a.every((w, i) => w.id === b[i].id && w.type === b[i].type && w.w === b[i].w);

export interface DashboardBoardProps {
  /** The viewer's layout (already limited to widgets they may see). */
  widgets: DashboardWidget[];
  /** dashboard_layouts.version (0 = role default, no row yet). */
  version: number;
  isDefault: boolean;
  /** Widget types this viewer may place (allowedWidgetTypes). */
  available: DashboardWidgetType[];
  /** Server-rendered widget bodies by type; `null` hides the widget in view mode (e.g. no bottlenecks). */
  content: Partial<Record<DashboardWidgetType, React.ReactNode>>;
  /** `?customise=1`. */
  editing: boolean;
  timeZone: string;
}

/**
 * Renders the dashboard from the user's DashboardLayout and hosts
 * "Customise" mode: drag to reorder (@dnd-kit/sortable, keyboard too),
 * resize, hide/show via the widget picker, save (PUT /api/dashboard/layout)
 * or reset to the role default (POST /api/dashboard/layout/reset).
 */
export function DashboardBoard({ widgets, version, isDefault, available, content, editing, timeZone }: DashboardBoardProps) {
  const ordered = React.useMemo(() => orderWidgets(widgets), [widgets]);

  if (editing) {
    return <DashboardEditor key={`${version}-${ordered.map((w) => w.id).join(",")}`} initial={ordered} version={version} isDefault={isDefault} available={available} timeZone={timeZone} />;
  }

  const visible = ordered.filter((w) => content[w.type] !== null && content[w.type] !== undefined);
  if (ordered.length === 0) {
    return (
      <EmptyState
        bordered
        icon={LayoutDashboard}
        title="Your dashboard is empty"
        description="Add the widgets you care about — workloads, deadlines, activity and more."
        action={
          <Button href="/dashboard?customise=1" leadingIcon={<Settings2 aria-hidden="true" />}>
            Customise dashboard
          </Button>
        }
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-12 lg:gap-5">
      {visible.map((w, i) => (
        <div
          key={w.id}
          className={cn("min-w-0 animate-slide-up", widgetSpanClass(w.w))}
          style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
        >
          {content[w.type]}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Customise mode                                                     */
/* ------------------------------------------------------------------ */

interface DashboardEditorProps {
  initial: DashboardWidget[];
  version: number;
  isDefault: boolean;
  available: DashboardWidgetType[];
  timeZone: string;
}

function DashboardEditor({ initial, version, isDefault, available, timeZone }: DashboardEditorProps) {
  const router = useRouter();
  const run = useMutationRunner();
  const [items, setItems] = React.useState<DashboardWidget[]>(initial);
  const [saving, setSaving] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [conflict, setConflict] = React.useState<ApiError | null>(null);
  const dirty = !sameLayout(items, initial);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const labelOf = React.useCallback(
    (id: string | number) => {
      const w = items.find((x) => x.id === id);
      return w ? WIDGET_META[w.type].label : "widget";
    },
    [items],
  );
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${labelOf(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${labelOf(active.id)} is over ${labelOf(over.id)}.` : `${labelOf(active.id)} is no longer over a widget.`),
    onDragEnd: ({ active, over }) => (over ? `${labelOf(active.id)} dropped at the position of ${labelOf(over.id)}.` : `${labelOf(active.id)} dropped.`),
    onDragCancel: ({ active }) => `Moving ${labelOf(active.id)} was cancelled.`,
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setItems((prev) => {
      const from = prev.findIndex((w) => w.id === active.id);
      const to = prev.findIndex((w) => w.id === over.id);
      return from < 0 || to < 0 ? prev : arrayMove(prev, from, to);
    });
  };

  const move = (id: string, delta: -1 | 1) =>
    setItems((prev) => {
      const from = prev.findIndex((w) => w.id === id);
      const to = from + delta;
      return from < 0 || to < 0 || to >= prev.length ? prev : arrayMove(prev, from, to);
    });

  const hidden = available.filter((t) => !items.some((w) => w.type === t));

  const add = (type: DashboardWidgetType) =>
    setItems((prev) => {
      let id: string = type;
      for (let n = 2; prev.some((w) => w.id === id); n += 1) id = `${type}-${n}`;
      return [...prev, { id, type, x: 0, y: 0, w: WIDGET_META[type].defaultWidth, h: 4 }];
    });

  const exit = () => router.replace("/dashboard", { scroll: false });

  const save = async () => {
    setSaving(true);
    const result = await run(() => api.put("/api/dashboard/layout", { layout: { widgets: packWidgets(items) }, expectedVersion: version }), {
      success: "Dashboard saved",
      onConflict: setConflict,
      noRefresh: true,
    });
    setSaving(false);
    if (result.ok) {
      exit();
      router.refresh();
    } else if (result.fieldErrors) {
      toast.error("Layout not saved", Object.values(result.fieldErrors)[0]?.[0] ?? "Check the widgets and try again.");
    }
  };

  const reset = async () => {
    const result = await run(() => api.post("/api/dashboard/layout/reset"), { success: "Dashboard reset to the default layout", noRefresh: true });
    if (!result.ok) return false;
    exit();
    router.refresh();
    return true;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-[calc(var(--topbar-height)+0.5rem)] z-20 flex flex-col gap-3 rounded-lg border border-accent/25 bg-surface/95 p-3 shadow-md backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:px-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">Customising your dashboard</p>
          <p className="text-xs text-ink-muted">Drag tiles (or use the grip with Space and arrow keys) to reorder, pick a size, or hide what you don&apos;t need.</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" leadingIcon={<RotateCcw aria-hidden="true" />} onClick={() => setResetOpen(true)} disabled={saving || isDefault}>
            Reset to default
          </Button>
          <Button variant="outline" size="sm" onClick={exit} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} loading={saving} disabled={!dirty && !isDefault}>
            Save layout
          </Button>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState bordered size="sm" icon={LayoutDashboard} title="No widgets on your dashboard" description="Add widgets from the list below." />
      ) : (
        <DndContext id="dashboard-layout" sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements }}>
          <SortableContext items={items.map((w) => w.id)} strategy={rectSortingStrategy}>
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-12 lg:gap-4" aria-label="Dashboard widgets">
              {items.map((w, i) => (
                <SortableTile
                  key={w.id}
                  widget={w}
                  first={i === 0}
                  last={i === items.length - 1}
                  onMove={(d) => move(w.id, d)}
                  onResize={(width) => setItems((prev) => prev.map((x) => (x.id === w.id ? { ...x, w: width } : x)))}
                  onHide={() => setItems((prev) => prev.filter((x) => x.id !== w.id))}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <section aria-labelledby="widget-picker-title" className="rounded-lg border border-dashed border-border-strong bg-surface-sunken/60 p-4">
        <h2 id="widget-picker-title" className="text-sm font-semibold text-ink">
          Add widgets
        </h2>
        {hidden.length === 0 ? (
          <p className="mt-1 text-sm text-ink-muted">Every widget available to you is already on your dashboard.</p>
        ) : (
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {hidden.map((type) => {
              const meta = WIDGET_META[type];
              const Icon = meta.icon;
              return (
                <li key={type}>
                  <button
                    type="button"
                    onClick={() => add(type)}
                    className="group/add flex w-full items-start gap-3 rounded-md border border-border bg-surface p-3 text-left shadow-xs transition-[border-color,box-shadow] duration-(--motion-fast) hover:border-border-hover hover:shadow-sm focus-ring"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-surface-muted text-ink-muted group-hover/add:bg-accent-soft group-hover/add:text-accent-ink">
                      <Icon aria-hidden="true" className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{meta.label}</span>
                      <span className="block text-xs text-ink-muted">{meta.description}</span>
                    </span>
                    <Plus aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-subtle group-hover/add:text-accent-ink" />
                    <span className="sr-only">Add {meta.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset your dashboard?"
        description="Your widget order, sizes and hidden widgets go back to the default for your role."
        confirmLabel="Reset layout"
        onConfirm={reset}
      />
      <ConflictDialog
        open={conflict !== null}
        onOpenChange={(open) => (open ? null : setConflict(null))}
        error={conflict}
        entity="dashboard layout"
        timeZone={timeZone}
        onReload={() => {
          setConflict(null);
          router.refresh();
        }}
      />
    </div>
  );
}

interface SortableTileProps {
  widget: DashboardWidget;
  first: boolean;
  last: boolean;
  onMove: (delta: -1 | 1) => void;
  onResize: (width: number) => void;
  onHide: () => void;
}

function SortableTile({ widget, first, last, onMove, onResize, onHide }: SortableTileProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: widget.id });
  const meta = WIDGET_META[widget.type];
  const Icon = meta.icon;
  const style: React.CSSProperties = { transform: CSS.Translate.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "min-w-0",
        widgetSpanClass(widget.w),
        isDragging && "relative z-10",
      )}
    >
      <div
        className={cn(
          "flex h-full min-h-32 flex-col rounded-lg border border-border bg-surface shadow-xs transition-shadow duration-(--motion-fast)",
          isDragging && "border-accent/40 shadow-pop",
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-2 py-2">
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${meta.label}`}
            className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted hover:text-ink active:cursor-grabbing focus-ring"
          >
            <GripVertical aria-hidden="true" className="size-4" />
          </button>
          <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{meta.label}</span>
          <IconButton label={`Hide ${meta.label}`} size="xs" onClick={onHide}>
            <EyeOff aria-hidden="true" />
          </IconButton>
        </div>
        <div className="flex flex-1 flex-col justify-between gap-3 p-3">
          <p className="text-xs text-ink-muted">{meta.description}</p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl
              size="sm"
              aria-label={`${meta.label} width`}
              options={WIDGET_WIDTHS.map((opt) => ({ value: String(opt.value), label: opt.label }))}
              value={String(nearestWidth(widget.w))}
              onValueChange={(v) => onResize(Number(v))}
            />
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => onMove(-1)} disabled={first} aria-label={`Move ${meta.label} earlier`}>
                Earlier
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onMove(1)} disabled={last} aria-label={`Move ${meta.label} later`}>
                Later
              </Button>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}
