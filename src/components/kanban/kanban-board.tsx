"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { Ban, ChevronDown, CircleSlash, Lock } from "lucide-react";
import { ConflictDialog } from "@/components/jobs/conflict-dialog";
import { jobHref } from "@/components/jobs/job-link";
import { ReasonDialog } from "@/components/jobs/reason-dialog";
import { RevisionRequestDialog } from "@/components/jobs/revision-request-dialog";
import { StatusPickerDialog, type StatusCandidate } from "@/components/jobs/status-picker-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useUrlState } from "@/hooks/use-url-state";
import { api, ApiError, errorMessage } from "@/lib/api-client";
import { KANBAN_COLUMN_META, KANBAN_COLUMNS, type KanbanColumn } from "@/lib/constants";
import type { KanbanCard, KanbanColumnView, KanbanDropResponse, KanbanMoveOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { KanbanCardView } from "./kanban-card";
import { columnColour, kanbanLimitKey, type BoardColumnKey } from "./shared";

/* ------------------------------------------------------------------ */
/*  Types + helpers                                                    */
/* ------------------------------------------------------------------ */

type BoardState = Record<BoardColumnKey, { cards: KanbanCard[]; count: number }>;

export interface KanbanBoardProps {
  columns: KanbanColumnView[];
  cancelled: { cards: KanbanCard[]; count: number } | null;
  /** Server render time; a change means fresh data (resets optimistic state). */
  asOf: string;
  timeZone: string;
  /** Cards loaded per column by default. */
  pageSize: number;
}

function toState(columns: KanbanColumnView[], cancelled: KanbanBoardProps["cancelled"]): BoardState {
  const out = {} as BoardState;
  for (const c of KANBAN_COLUMNS) out[c] = { cards: [], count: 0 };
  for (const view of columns) out[view.column] = { cards: view.cards, count: view.count };
  out.cancelled = cancelled ? { cards: cancelled.cards, count: cancelled.count } : { cards: [], count: 0 };
  return out;
}

const COLUMN_DROP_PREFIX = "column:";
const columnOfDropId = (id: unknown): KanbanColumn | null => {
  if (typeof id !== "string" || !id.startsWith(COLUMN_DROP_PREFIX)) return null;
  const c = id.slice(COLUMN_DROP_PREFIX.length);
  return (KANBAN_COLUMNS as readonly string[]).includes(c) ? (c as KanbanColumn) : null;
};

const labelOf = (column: BoardColumnKey) => (column === "cancelled" ? "Cancelled" : KANBAN_COLUMN_META[column].label);

/** Pointer first (precise), then rectangle overlap (keyboard drags have no pointer). */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

/** ← / → jump a whole column; ↑ / ↓ nudge (the default 25px steps are too slow for a board). */
const columnKeyboardCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  const { collisionRect, droppableRects, droppableContainers, over } = context;
  if (!collisionRect) return undefined;
  if (event.code === "ArrowDown" || event.code === "ArrowUp") {
    event.preventDefault();
    return { x: currentCoordinates.x, y: currentCoordinates.y + (event.code === "ArrowDown" ? 48 : -48) };
  }
  if (event.code !== "ArrowRight" && event.code !== "ArrowLeft") return undefined;
  event.preventDefault();
  const targets = droppableContainers
    .getEnabled()
    .map((c) => ({ id: c.id, rect: droppableRects.get(c.id) }))
    .filter((t): t is { id: typeof t.id; rect: NonNullable<typeof t.rect> } => Boolean(t.rect))
    .sort((a, b) => a.rect.left - b.rect.left);
  const centre = collisionRect.left + collisionRect.width / 2;
  let index = targets.findIndex((t) => t.id === over?.id);
  if (index < 0) index = targets.findIndex((t) => centre >= t.rect.left && centre <= t.rect.left + t.rect.width);
  const next = targets[index + (event.code === "ArrowRight" ? 1 : -1)];
  if (!next) return currentCoordinates;
  return { x: next.rect.left + next.rect.width / 2 - collisionRect.width / 2, y: next.rect.top + 56 };
};

/* ------------------------------------------------------------------ */
/*  Follow-up flows after a drop                                       */
/* ------------------------------------------------------------------ */

interface DropContext {
  card: KanbanCard;
  from: BoardColumnKey;
  fromIndex: number;
  to: KanbanColumn;
  /** The card was moved optimistically and must be put back on failure. */
  moved: boolean;
}

type Flow =
  | ({ kind: "pick"; candidates: KanbanMoveOption[] } & DropContext)
  | ({ kind: "reason"; move: KanbanMoveOption } & DropContext)
  | ({ kind: "revision"; move: KanbanMoveOption } & DropContext)
  | { kind: "conflict"; error: ApiError };

/* ------------------------------------------------------------------ */
/*  Board                                                              */
/* ------------------------------------------------------------------ */

/**
 * Seven-column production board (spec §9, ARCHITECTURE §4.6). Drag a card
 * (mouse, touch-and-hold, or Space + arrow keys) onto a column; the drop is
 * sent to `POST /api/kanban/drop`, which resolves the column to a workflow
 * status and records the transition. Moves are optimistic and roll back on
 * any error; follow-ups (status picker, reason, revision request) open as
 * dialogs. Columns the card may not enter are dimmed while dragging.
 */
export function KanbanBoard({ columns, cancelled, asOf, timeZone, pageSize }: KanbanBoardProps) {
  const router = useRouter();
  const url = useUrlState();

  const [state, setState] = React.useState<BoardState>(() => toState(columns, cancelled));
  const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set());
  const [syncedAsOf, setSyncedAsOf] = React.useState(asOf);
  if (asOf !== syncedAsOf) {
    // Fresh server data (router.refresh or a filter change): drop optimistic state.
    setSyncedAsOf(asOf);
    setState(toState(columns, cancelled));
    setPending(new Set());
  }

  const [active, setActive] = React.useState<{ card: KanbanCard; from: BoardColumnKey } | null>(null);
  const [overColumn, setOverColumn] = React.useState<KanbanColumn | null>(null);
  const [flow, setFlowState] = React.useState<Flow | null>(null);
  const flowRef = React.useRef<Flow | null>(null);
  const setFlow = React.useCallback((next: Flow | null) => {
    flowRef.current = next;
    setFlowState(next);
  }, []);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: columnKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  /* ---- optimistic moves ---- */

  const moveCard = React.useCallback((card: KanbanCard, from: BoardColumnKey, to: BoardColumnKey, index = 0) => {
    setState((prev) => {
      if (from === to) return prev;
      const source = prev[from].cards.filter((c) => c.id !== card.id);
      const removed = source.length !== prev[from].cards.length;
      const target = prev[to].cards.filter((c) => c.id !== card.id);
      target.splice(Math.min(index, target.length), 0, card);
      return {
        ...prev,
        [from]: { cards: source, count: Math.max(0, prev[from].count - (removed ? 1 : 0)) },
        [to]: { cards: target, count: prev[to].count + 1 },
      };
    });
  }, []);

  const setCardPending = React.useCallback((id: string, on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const rollback = React.useCallback(
    (ctx: DropContext) => {
      setCardPending(ctx.card.id, false);
      if (ctx.moved) moveCard(ctx.card, ctx.to, ctx.from, ctx.fromIndex);
    },
    [moveCard, setCardPending],
  );

  /** Sends the drop (or its follow-up) and routes the response. */
  const send = React.useCallback(
    async (ctx: DropContext, extra: { toStatusId?: string; reason?: string } = {}): Promise<boolean> => {
      setCardPending(ctx.card.id, true);
      try {
        const res = await api.post<KanbanDropResponse>("/api/kanban/drop", {
          jobId: ctx.card.id,
          column: ctx.to,
          expectedVersion: ctx.card.version,
          ...extra,
        });
        switch (res.kind) {
          case "noop":
            setFlow(null);
            rollback(ctx);
            return true;
          case "moved":
            setFlow(null);
            if (res.warnings.length > 0) toast.warning(`${ctx.card.jobNumber} moved to ${res.toStatus.name}`, res.warnings.join(" "));
            else toast.success(`${ctx.card.jobNumber} moved to ${res.toStatus.name}`);
            router.refresh();
            return true;
          case "ambiguous":
            setFlow({ kind: "pick", candidates: res.candidates, ...ctx });
            return true;
          case "needs_reason":
            setFlow({ kind: "reason", move: res.move, ...ctx });
            return true;
          case "needs_revision_payload":
            setFlow({ kind: "revision", move: res.move, ...ctx });
            return true;
        }
      } catch (err) {
        rollback(ctx);
        if (err instanceof ApiError && err.isConflict) {
          setFlow({ kind: "conflict", error: err });
        } else {
          setFlow(null);
          toast.error(`Can't move ${ctx.card.jobNumber} to ${labelOf(ctx.to)}`, errorMessage(err));
        }
        return true;
      }
      return true;
    },
    [rollback, router, setCardPending, setFlow],
  );

  /** A dialog closed: if its flow is still the current one, the user backed out. */
  const dismissFlow = React.useCallback(
    (closing: Flow) => {
      // Deferred so success callbacks (onDone / onPick) fired in the same tick win.
      window.setTimeout(() => {
        if (flowRef.current !== closing) return;
        setFlow(null);
        if (closing.kind !== "conflict") rollback(closing);
      }, 0);
    },
    [rollback, setFlow],
  );

  /* ---- drag lifecycle ---- */

  const findCard = (id: unknown): { card: KanbanCard; from: BoardColumnKey; index: number } | null => {
    for (const key of [...KANBAN_COLUMNS, "cancelled"] as BoardColumnKey[]) {
      const index = state[key].cards.findIndex((c) => c.id === id);
      if (index >= 0) return { card: state[key].cards[index], from: key, index };
    }
    return null;
  };

  const onDragStart = (event: DragStartEvent) => {
    const found = findCard(event.active.id);
    if (found) setActive({ card: found.card, from: found.from });
  };

  const onDragOver = (event: DragOverEvent) => setOverColumn(columnOfDropId(event.over?.id));

  const onDragEnd = (event: DragEndEvent) => {
    setActive(null);
    setOverColumn(null);
    const to = columnOfDropId(event.over?.id);
    const found = findCard(event.active.id);
    if (!to || !found || found.from === to) return;
    if (pending.has(found.card.id)) {
      toast.info("Still saving the last move", "Try again in a moment.");
      return;
    }
    const allowed = found.card.allowedColumns.includes(to);
    // Allowed → move now and confirm; not allowed → ask the server anyway so the toast explains why.
    if (allowed) moveCard(found.card, found.from, to);
    void send({ card: found.card, from: found.from, fromIndex: found.index, to, moved: allowed });
  };

  const onDragCancel = () => {
    setActive(null);
    setOverColumn(null);
  };

  /* ---- a11y copy ---- */

  const announcements: Announcements = {
    onDragStart: ({ active: a }) => {
      const card = findCard(a.id)?.card;
      return card ? `Picked up ${card.jobNumber}, ${card.name}. Use left and right arrows to choose a column, space to drop, escape to cancel.` : undefined;
    },
    onDragOver: ({ active: a, over }) => {
      const to = columnOfDropId(over?.id);
      const card = findCard(a.id)?.card;
      if (!to || !card) return undefined;
      return card.allowedColumns.includes(to) ? `Over ${labelOf(to)}.` : `Over ${labelOf(to)} — this job can't move there.`;
    },
    onDragEnd: ({ over }) => {
      const to = columnOfDropId(over?.id);
      return to ? `Dropped on ${labelOf(to)}.` : "Dropped. No column selected.";
    },
    onDragCancel: () => "Move cancelled.",
  };

  const visible: BoardColumnKey[] = cancelled ? [...KANBAN_COLUMNS, "cancelled"] : [...KANBAN_COLUMNS];

  const jumpTo = (column: BoardColumnKey) => {
    document.getElementById(`kanban-col-${column}`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
  };

  return (
    <>
      {/* Mobile column jump bar (thumb-reachable column switcher). */}
      <nav aria-label="Jump to column" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 scrollbar-none md:hidden">
        {visible.map((column) => (
          <button
            key={column}
            type="button"
            onClick={() => jumpTo(column)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-xs font-medium text-ink-secondary focus-ring"
          >
            <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: columnColour(column) }} />
            {labelOf(column)}
            <span className="numeric text-ink-subtle">{state[column].count}</span>
          </button>
        ))}
      </nav>

      <p id="kanban-dnd-help" className="sr-only">
        Press space to pick up a job card, left and right arrows to move between columns, space to drop, escape to cancel. Press enter to open the job.
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{ announcements, screenReaderInstructions: { draggable: "" } }}
        autoScroll={{ threshold: { x: 0.15, y: 0.15 } }}
      >
        <div
          className={cn(
            "-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-4 scrollbar-thin sm:-mx-6 sm:scroll-px-6 sm:px-6 md:snap-none lg:-mx-8 lg:px-8",
            url.isPending && "opacity-80 transition-opacity",
          )}
        >
          {visible.map((column) => (
            <BoardColumn
              key={column}
              column={column}
              cards={state[column].cards}
              count={state[column].count}
              timeZone={timeZone}
              pending={pending}
              activeCard={active?.card ?? null}
              activeFrom={active?.from ?? null}
              isOver={overColumn === column}
              pageSize={pageSize}
              onLoadMore={() => url.set(kanbanLimitKey(column), state[column].cards.length + pageSize)}
              loadingMore={url.isPending}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {active ? (
            <div className="w-[min(86vw,18rem)] md:w-72">
              <KanbanCardView card={active.card} timeZone={timeZone} overlay />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <FlowDialogs flow={flow} send={send} dismissFlow={dismissFlow} setFlow={setFlow} rollback={rollback} timeZone={timeZone} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Column                                                             */
/* ------------------------------------------------------------------ */

interface BoardColumnProps {
  column: BoardColumnKey;
  cards: KanbanCard[];
  count: number;
  timeZone: string;
  pending: ReadonlySet<string>;
  activeCard: KanbanCard | null;
  activeFrom: BoardColumnKey | null;
  isOver: boolean;
  pageSize: number;
  onLoadMore: () => void;
  loadingMore: boolean;
}

function BoardColumn({ column, cards, count, timeZone, pending, activeCard, activeFrom, isOver, pageSize, onLoadMore, loadingMore }: BoardColumnProps) {
  const droppable = column !== "cancelled";
  const { setNodeRef } = useDroppable({ id: `${COLUMN_DROP_PREFIX}${column}`, disabled: !droppable });
  const colour = columnColour(column);

  const dragging = activeCard !== null;
  const isOrigin = activeFrom === column;
  const allowed = droppable && activeCard !== null && (isOrigin || activeCard.allowedColumns.includes(column as KanbanColumn));
  const dimmed = dragging && !allowed && !isOrigin;

  const overdue = cards.filter((c) => c.isOverdue).length;
  const dueToday = cards.filter((c) => c.isDueToday).length;
  const multiStatus = column === "cancelled" ? false : KANBAN_COLUMN_META[column].categories.length > 1;
  const remaining = Math.max(0, count - cards.length);

  return (
    <section
      id={`kanban-col-${column}`}
      aria-label={`${labelOf(column)}, ${count} ${count === 1 ? "job" : "jobs"}`}
      className={cn(
        "flex w-[86vw] max-w-80 shrink-0 snap-start flex-col rounded-lg border border-border bg-surface-sunken/70 sm:w-72 md:w-72",
        "transition-[opacity,box-shadow,background-color] duration-(--motion-base) ease-out-soft",
        dimmed && "opacity-45",
        isOver && allowed && !isOrigin && "bg-accent-soft/40 ring-2 ring-accent/50",
        isOver && dimmed && "ring-2 ring-danger/40",
      )}
    >
      <header className="relative px-3 pb-2.5 pt-3">
        <span aria-hidden="true" className="absolute inset-x-3 top-0 h-0.5 rounded-b-full" style={{ backgroundColor: colour }} />
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colour }} />
            <span className="truncate">{labelOf(column)}</span>
          </h2>
          <span className="numeric rounded-full bg-surface px-2 py-0.5 text-xs font-semibold text-ink-secondary ring-1 ring-inset ring-border">
            {count}
          </span>
        </div>
        <div className="mt-1.5 flex min-h-5 flex-wrap items-center gap-1.5 text-2xs">
          {overdue > 0 ? (
            <span className="numeric inline-flex items-center rounded-full bg-danger-soft px-1.5 py-0.5 font-medium text-danger-fg">{overdue} overdue</span>
          ) : null}
          {dueToday > 0 ? (
            <span className="numeric inline-flex items-center rounded-full bg-attention-soft px-1.5 py-0.5 font-medium text-attention-fg">
              {dueToday} due today
            </span>
          ) : null}
          {overdue === 0 && dueToday === 0 ? <span className="text-ink-subtle">{count === 0 ? "Empty" : "On track"}</span> : null}
          {dimmed ? (
            <span className="ml-auto inline-flex items-center gap-1 font-medium text-ink-muted">
              <Lock aria-hidden="true" className="size-3" /> Not allowed
            </span>
          ) : null}
        </div>
      </header>

      <div
        ref={setNodeRef}
        className="flex min-h-32 flex-1 flex-col gap-2 px-2 pb-2 md:max-h-[calc(100dvh-17rem)] md:overflow-y-auto md:scrollbar-thin"
      >
        {cards.length === 0 ? (
          <div
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border-strong/70 px-3 py-8 text-center text-xs text-ink-subtle",
              dragging && allowed && !isOrigin && "border-accent/60 text-accent-ink",
            )}
          >
            {column === "cancelled" ? <Ban aria-hidden="true" className="size-4" /> : <CircleSlash aria-hidden="true" className="size-4" />}
            {dragging && allowed && !isOrigin ? "Drop here" : "No jobs here"}
          </div>
        ) : (
          cards.map((card) => (
            <DraggableCard key={card.id} card={card} timeZone={timeZone} pending={pending.has(card.id)} showStatus={multiStatus} />
          ))
        )}

        {remaining > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 w-full justify-center text-ink-muted"
            onClick={onLoadMore}
            loading={loadingMore}
            trailingIcon={<ChevronDown aria-hidden="true" className="size-3.5" />}
          >
            Show {Math.min(pageSize, remaining)} more
            <span className="numeric text-ink-subtle">· {remaining} hidden</span>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Card                                                               */
/* ------------------------------------------------------------------ */

function DraggableCard({ card, timeZone, pending, showStatus }: { card: KanbanCard; timeZone: string; pending: boolean; showStatus: boolean }) {
  const router = useRouter();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id, disabled: pending });

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    listeners?.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter") {
      event.preventDefault();
      router.push(jobHref(card.id));
    }
  };

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onKeyDown={onKeyDown}
      aria-roledescription="Draggable job card"
      aria-describedby="kanban-dnd-help"
      aria-label={`${card.jobNumber} ${card.name}, ${card.client.name}${card.isOverdue ? ", overdue" : card.isDueToday ? ", due today" : ""}`}
      className={cn(
        "group/card shrink-0 cursor-grab touch-manipulation rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface-sunken",
        pending && "cursor-progress",
      )}
    >
      <KanbanCardView card={card} timeZone={timeZone} ghost={isDragging} pending={pending} showStatus={showStatus} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Follow-up dialogs                                                  */
/* ------------------------------------------------------------------ */

function FlowDialogs({
  flow,
  send,
  dismissFlow,
  setFlow,
  rollback,
  timeZone,
}: {
  flow: Flow | null;
  send: (ctx: DropContext, extra?: { toStatusId?: string; reason?: string }) => Promise<boolean>;
  dismissFlow: (flow: Flow) => void;
  setFlow: (flow: Flow | null) => void;
  rollback: (ctx: DropContext) => void;
  timeZone: string;
}) {
  if (!flow) return null;

  if (flow.kind === "conflict") {
    return (
      <ConflictDialog
        open
        onOpenChange={(open) => {
          if (!open) setFlow(null);
        }}
        error={flow.error}
        entity="job"
        timeZone={timeZone}
      />
    );
  }

  const label = `${flow.card.jobNumber} · ${flow.card.name}`;

  if (flow.kind === "pick") {
    const candidates: StatusCandidate[] = flow.candidates.map((c) => ({
      id: c.toStatus.id,
      name: c.toStatus.name,
      key: c.toStatus.key,
      category: c.toStatus.category,
      colour: c.toStatus.colour,
      hint: c.label,
    }));
    return (
      <StatusPickerDialog
        open
        onOpenChange={(open) => {
          if (!open) dismissFlow(flow);
        }}
        candidates={candidates}
        title={`Move to ${KANBAN_COLUMN_META[flow.to].label}`}
        description={`${label} can go to more than one status in this column. Pick one.`}
        onPick={(statusId) => send(flow, { toStatusId: statusId })}
      />
    );
  }

  if (flow.kind === "reason") {
    return (
      <ReasonDialog
        open
        onOpenChange={(open) => {
          if (!open) dismissFlow(flow);
        }}
        title={flow.move.isReopen ? "Reopen this job?" : flow.move.label}
        description={
          <>
            <span className="font-medium text-ink-secondary">{label}</span> → {flow.move.toStatus.name}. A reason is required and kept in the job history.
          </>
        }
        confirmLabel={flow.move.isReopen ? "Reopen job" : "Move job"}
        destructive={flow.move.toStatus.category === "cancelled"}
        onSubmit={(reason) => send(flow, { toStatusId: flow.move.toStatus.id, reason })}
      />
    );
  }

  return (
    <RevisionRequestDialog
      open
      onOpenChange={(open) => {
        if (!open) dismissFlow(flow);
      }}
      jobId={flow.card.id}
      version={flow.card.version}
      jobLabel={label}
      currentEditor={flow.card.editor}
      toStatusId={flow.move.toStatus.id}
      isReopen={flow.move.isReopen}
      defaultPriority={flow.card.priority}
      timeZone={timeZone}
      onConflict={(error) => {
        rollback(flow);
        setFlow({ kind: "conflict", error });
      }}
      onDone={() => setFlow(null)}
    />
  );
}
