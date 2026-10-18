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
import { Ban, ChevronDown, CircleSlash, Images, Lock } from "lucide-react";
import { ApproveButton } from "@/components/job-simple/approve-button";
import { AskForChangesDialog } from "@/components/job-simple/ask-for-changes-dialog";
import { AssignEditorDialog } from "@/components/job-simple/assign-editor-dialog";
import { ReopenDialog } from "@/components/job-simple/reopen-dialog";
import { SendForCheckingDialog } from "@/components/job-simple/send-for-checking";
import { useConflict } from "@/components/job-simple/use-conflict";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { useUrlState } from "@/hooks/use-url-state";
import type { ApiError } from "@/lib/api-client";
import { STAGE_META, type Stage } from "@/lib/stages";
import type { StageBoardCard, StageBoardColumn, StageBoardMoveAction } from "@/lib/types";
import { cn } from "@/lib/utils";
import { KanbanCardView } from "./kanban-card";
import { BOARD_STAGES, MOVE_BUTTON_LABEL, columnLabel, columnTone, kanbanLimitKey, whyNotMove, type BoardColumnKey } from "./shared";

/* ------------------------------------------------------------------ */
/*  Types + helpers                                                    */
/* ------------------------------------------------------------------ */

type BoardState = Record<BoardColumnKey, { cards: StageBoardCard[]; count: number }>;

export interface KanbanBoardProps {
  columns: StageBoardColumn[];
  cancelled: StageBoardColumn | null;
  /** The viewer's id ("Waiting on: You"). */
  viewerId: string | null;
  /** Server render time; a change means fresh data (resets optimistic state). */
  asOf: string;
  timeZone: string;
  /** Cards loaded per column by default. */
  pageSize: number;
}

const ALL_COLUMNS: readonly BoardColumnKey[] = [...BOARD_STAGES, "cancelled"];

function toState(columns: StageBoardColumn[], cancelled: StageBoardColumn | null): BoardState {
  const out = {} as BoardState;
  for (const c of ALL_COLUMNS) out[c] = { cards: [], count: 0 };
  for (const view of columns) out[view.stage] = { cards: view.cards, count: view.count };
  if (cancelled) out.cancelled = { cards: cancelled.cards, count: cancelled.count };
  return out;
}

const COLUMN_DROP_PREFIX = "column:";
const columnOfDropId = (id: unknown): Stage | null => {
  if (typeof id !== "string" || !id.startsWith(COLUMN_DROP_PREFIX)) return null;
  const c = id.slice(COLUMN_DROP_PREFIX.length);
  return (BOARD_STAGES as readonly string[]).includes(c) ? (c as Stage) : null;
};

/** The button a drop of `card` on `column` would press, or null when it is not one of the viewer's steps. */
const moveTo = (card: StageBoardCard, column: BoardColumnKey): StageBoardMoveAction | null => card.moves.find((m) => m.to === column)?.action ?? null;

/**
 * A column's name drawn exactly like the stage pill on the Jobs list (same tone classes and dot),
 * so the Board reads like everywhere else (SIMPLIFICATION-PLAN §4, §8). `size="md"` for column
 * headers, `sm` for the phone jump chips.
 */
function ColumnPill({ column, size = "sm", className, children }: { column: BoardColumnKey; size?: "sm" | "md"; className?: string; children?: React.ReactNode }) {
  const tone = columnTone(column);
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-sm",
        tone.pill,
        className,
      )}
      data-stage={column}
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
      <span className="truncate">{columnLabel(column)}</span>
      {children}
    </span>
  );
}

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

/** A drop the viewer may make: the dialog of that button opens over the board. */
interface Flow {
  /** One per drop, so a dismissed question never blocks the next drop of the same card. */
  key: number;
  card: StageBoardCard;
  from: BoardColumnKey;
  to: Stage;
  action: StageBoardMoveAction;
}

/* ------------------------------------------------------------------ */
/*  Board                                                              */
/* ------------------------------------------------------------------ */

/**
 * The Board in the five stages (docs/SIMPLIFICATION-PLAN.md §8 follow-up). Drag a card (mouse,
 * touch-and-hold, or Space + arrow keys) onto a column: when that step is one of the viewer's own
 * buttons the matching dialog opens — Assign editor, Send for checking, Approve (with the share
 * question), Ask for changes, Reopen — and the job moves through `POST /api/jobs/:id/simple/*`
 * exactly as from the job page. Any other drop snaps back with a plain toast saying why. Columns
 * the card cannot go to are dimmed while dragging; the card moves once the dialog succeeds.
 */
export function KanbanBoard({ columns, cancelled, viewerId, asOf, timeZone, pageSize }: KanbanBoardProps) {
  const router = useRouter();
  const url = useUrlState();
  const { onConflict: staleJob } = useConflict(timeZone);

  const [state, setState] = React.useState<BoardState>(() => toState(columns, cancelled));
  const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set());
  const [syncedAsOf, setSyncedAsOf] = React.useState(asOf);
  if (asOf !== syncedAsOf) {
    // Fresh server data (router.refresh or a filter change): drop optimistic state.
    setSyncedAsOf(asOf);
    setState(toState(columns, cancelled));
    setPending(new Set());
  }

  const [active, setActive] = React.useState<{ card: StageBoardCard; from: BoardColumnKey } | null>(null);
  const [overColumn, setOverColumn] = React.useState<Stage | null>(null);
  const [flow, setFlow] = React.useState<Flow | null>(null);
  const flowCount = React.useRef(0);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: columnKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  /* ---- after a dialog ---- */

  const moveCard = React.useCallback((card: StageBoardCard, from: BoardColumnKey, to: BoardColumnKey) => {
    setState((prev) => {
      if (from === to) return prev;
      const source = prev[from].cards.filter((c) => c.job.id !== card.job.id);
      const removed = source.length !== prev[from].cards.length;
      const target = [card, ...prev[to].cards.filter((c) => c.job.id !== card.job.id)];
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

  /** The dialog succeeded: show the card in its new column (greyed) until the refreshed board arrives. */
  const onDone = React.useCallback(
    (done: Flow, moves: boolean) => {
      setFlow(null);
      setCardPending(done.card.job.id, true);
      if (moves) moveCard(done.card, done.from, done.to);
      router.refresh();
    },
    [moveCard, router, setCardPending],
  );

  /** 409 / "the job moved on": close the dialog, refresh, one toast (useConflict). */
  const onConflict = React.useCallback(
    (err: ApiError) => {
      setFlow(null);
      staleJob(err);
    },
    [staleJob],
  );

  /* ---- drag lifecycle ---- */

  const findCard = (id: unknown): { card: StageBoardCard; from: BoardColumnKey } | null => {
    for (const key of ALL_COLUMNS) {
      const card = state[key].cards.find((c) => c.job.id === id);
      if (card) return { card, from: key };
    }
    return null;
  };

  const onDragStart = (event: DragStartEvent) => {
    const found = findCard(event.active.id);
    if (found) setActive(found);
  };

  const onDragOver = (event: DragOverEvent) => setOverColumn(columnOfDropId(event.over?.id));

  const onDragEnd = (event: DragEndEvent) => {
    setActive(null);
    setOverColumn(null);
    const to = columnOfDropId(event.over?.id);
    const found = findCard(event.active.id);
    if (!to || !found || found.from === to) return;
    if (pending.has(found.card.job.id)) {
      toast.info("Still saving the last move", "Try again in a moment.");
      return;
    }
    const action = moveTo(found.card, to);
    if (!action) {
      toast.info(`Can't move ${found.card.job.name} there`, whyNotMove(found.card, to));
      return;
    }
    flowCount.current += 1;
    setFlow({ key: flowCount.current, card: found.card, from: found.from, to, action });
  };

  const onDragCancel = () => {
    setActive(null);
    setOverColumn(null);
  };

  /* ---- a11y copy ---- */

  const announcements: Announcements = {
    onDragStart: ({ active: a }) => {
      const card = findCard(a.id)?.card;
      return card ? `Picked up ${card.job.jobNumber}, ${card.job.name}. Use left and right arrows to choose a stage, space to drop, escape to cancel.` : undefined;
    },
    onDragOver: ({ active: a, over }) => {
      const to = columnOfDropId(over?.id);
      const found = findCard(a.id);
      if (!to || !found) return undefined;
      if (to === found.from) return `Over ${columnLabel(to)}, where it is now.`;
      const action = moveTo(found.card, to);
      return action ? `Over ${columnLabel(to)}: ${MOVE_BUTTON_LABEL[action]}.` : `Over ${columnLabel(to)} — not a step from here.`;
    },
    onDragEnd: ({ over }) => {
      const to = columnOfDropId(over?.id);
      return to ? `Dropped on ${columnLabel(to)}.` : "Dropped. No stage selected.";
    },
    onDragCancel: () => "Move cancelled.",
  };

  const visible: BoardColumnKey[] = cancelled ? [...BOARD_STAGES, "cancelled"] : [...BOARD_STAGES];

  const jumpTo = (column: BoardColumnKey) => {
    document.getElementById(`kanban-col-${column}`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
  };

  return (
    <>
      {/* Phone stage jump bar (thumb-reachable); the chips are the stage pills with a count. */}
      <nav aria-label="Jump to stage" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 scrollbar-none md:hidden">
        {visible.map((column) => (
          <button key={column} type="button" onClick={() => jumpTo(column)} aria-label={`${columnLabel(column)}, ${state[column].count}`} className="shrink-0 rounded-full focus-ring">
            <ColumnPill column={column} size="md">
              <span className="numeric font-normal opacity-80">{state[column].count}</span>
            </ColumnPill>
          </button>
        ))}
      </nav>

      <p id="kanban-dnd-help" className="sr-only">
        Press space to pick up a job card, left and right arrows to move between stages, space to drop, escape to cancel. Press enter to open the job.
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
              viewerId={viewerId}
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
              <KanbanCardView card={active.card} timeZone={timeZone} viewerId={viewerId} overlay />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {flow ? <FlowDialog key={flow.key} flow={flow} timeZone={timeZone} onClose={() => setFlow(null)} onConflict={onConflict} onDone={onDone} /> : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Column                                                             */
/* ------------------------------------------------------------------ */

interface BoardColumnProps {
  column: BoardColumnKey;
  cards: StageBoardCard[];
  count: number;
  timeZone: string;
  viewerId: string | null;
  pending: ReadonlySet<string>;
  activeCard: StageBoardCard | null;
  activeFrom: BoardColumnKey | null;
  isOver: boolean;
  pageSize: number;
  onLoadMore: () => void;
  loadingMore: boolean;
}

function BoardColumn({ column, cards, count, timeZone, viewerId, pending, activeCard, activeFrom, isOver, pageSize, onLoadMore, loadingMore }: BoardColumnProps) {
  const droppable = column !== "cancelled";
  const { setNodeRef } = useDroppable({ id: `${COLUMN_DROP_PREFIX}${column}`, disabled: !droppable });
  const tone = columnTone(column);

  const dragging = activeCard !== null;
  const isOrigin = activeFrom === column;
  const action = droppable && activeCard ? moveTo(activeCard, column) : null;
  const allowed = isOrigin || action !== null;
  const dimmed = dragging && !allowed;
  const target = dragging && action !== null && !isOrigin;

  const late = cards.filter((c) => c.job.due.late).length;
  const dueToday = cards.filter((c) => c.job.stage.active && c.job.due.daysFromToday === 0).length;
  const remaining = Math.max(0, count - cards.length);

  return (
    <section
      id={`kanban-col-${column}`}
      aria-label={`${columnLabel(column)}, ${count} ${count === 1 ? "job" : "jobs"}`}
      className={cn(
        "flex w-[86vw] max-w-80 shrink-0 snap-start flex-col rounded-lg border border-border bg-surface-sunken/70 sm:w-72 md:w-72",
        "transition-[opacity,box-shadow,background-color] duration-(--motion-base) ease-out-soft",
        dimmed && "opacity-45",
        isOver && target && "bg-accent-soft/40 ring-2 ring-accent/50",
        isOver && dimmed && "ring-2 ring-danger/40",
      )}
    >
      <header className="relative px-3 pb-2.5 pt-3">
        <span aria-hidden="true" className={cn("absolute inset-x-3 top-0 h-0.5 rounded-b-full", tone.dot)} />
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex min-w-0 items-center">
            <ColumnPill column={column} size="md" />
          </h2>
          <span className="numeric rounded-full bg-surface px-2 py-0.5 text-xs font-semibold text-ink-secondary ring-1 ring-inset ring-border">{count}</span>
        </div>
        <div className="mt-1.5 flex min-h-5 flex-wrap items-center gap-1.5 text-2xs">
          {target ? (
            <span className="inline-flex items-center gap-1 font-medium text-accent-ink">Drop here · {MOVE_BUTTON_LABEL[action]}</span>
          ) : dimmed ? (
            <span className="inline-flex items-center gap-1 font-medium text-ink-muted">
              <Lock aria-hidden="true" className="size-3" /> Not a step from here
            </span>
          ) : (
            <>
              {late > 0 ? <span className="numeric inline-flex items-center rounded-full bg-danger-soft px-1.5 py-0.5 font-medium text-danger-fg">{late} late</span> : null}
              {dueToday > 0 ? (
                <span className="numeric inline-flex items-center rounded-full bg-attention-soft px-1.5 py-0.5 font-medium text-attention-fg">{dueToday} due today</span>
              ) : null}
              {late === 0 && dueToday === 0 ? <span className="truncate text-ink-subtle">{STAGE_META[column].description}</span> : null}
            </>
          )}
        </div>
      </header>

      <div ref={setNodeRef} className="flex min-h-32 flex-1 flex-col gap-2 px-2 pb-2 md:max-h-[calc(100dvh-17rem)] md:overflow-y-auto md:scrollbar-thin">
        {cards.length === 0 ? (
          <div
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border-strong/70 px-3 py-8 text-center text-xs text-ink-subtle",
              target && "border-accent/60 text-accent-ink",
            )}
          >
            {column === "cancelled" ? <Ban aria-hidden="true" className="size-4" /> : <CircleSlash aria-hidden="true" className="size-4" />}
            {target ? "Drop here" : "No jobs here"}
          </div>
        ) : (
          cards.map((card) => <DraggableCard key={card.job.id} card={card} timeZone={timeZone} viewerId={viewerId} pending={pending.has(card.job.id)} />)
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

function DraggableCard({ card, timeZone, viewerId, pending }: { card: StageBoardCard; timeZone: string; viewerId: string | null; pending: boolean }) {
  const router = useRouter();
  const { job } = card;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: job.id, disabled: pending });

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    listeners?.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter") {
      event.preventDefault();
      router.push(`/jobs/${encodeURIComponent(job.id)}`);
    }
  };

  const dueWords = job.due.late ? ", late" : job.stage.active && job.due.daysFromToday === 0 ? ", due today" : "";

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onKeyDown={onKeyDown}
      aria-roledescription="Draggable job card"
      aria-describedby="kanban-dnd-help"
      aria-label={`${job.jobNumber} ${job.name}, ${job.client.name}${dueWords}`}
      className={cn(
        "group/card shrink-0 cursor-grab touch-manipulation rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface-sunken",
        pending && "cursor-progress",
      )}
    >
      <KanbanCardView card={card} timeZone={timeZone} viewerId={viewerId} ghost={isDragging} pending={pending} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  The dialog a drop opens                                            */
/* ------------------------------------------------------------------ */

interface FlowDialogProps {
  flow: Flow;
  timeZone: string;
  onClose: () => void;
  onConflict: (error: ApiError) => void;
  onDone: (flow: Flow, moves: boolean) => void;
}

/** The SAME dialogs as the job page, Home and My jobs (`@/components/job-simple`) — never a local copy. */
function FlowDialog({ flow, timeZone, onClose, onConflict, onDone }: FlowDialogProps) {
  const { job } = flow.card;
  const jobLabel = `${job.name} · ${job.client.name}`;
  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  switch (flow.action) {
    case "assign":
      return <AssignEditorDialog open onOpenChange={onOpenChange} jobId={job.id} version={job.version} jobLabel={jobLabel} onConflict={onConflict} onDone={() => onDone(flow, true)} />;
    case "send_for_checking":
      return (
        <SendForCheckingDialog
          open
          onOpenChange={onOpenChange}
          jobId={job.id}
          version={job.version}
          lastLink={job.finishedLink}
          hasCurrentLink={job.finishedLink !== null}
          checkerName={job.photographer?.name ?? null}
          jobLabel={jobLabel}
          onConflict={onConflict}
          onDone={() => onDone(flow, true)}
        />
      );
    case "ask_for_changes":
      return (
        <AskForChangesDialog
          open
          onOpenChange={onOpenChange}
          jobId={job.id}
          version={job.version}
          editorName={job.editor?.name ?? null}
          jobLabel={jobLabel}
          timeZone={timeZone}
          onConflict={onConflict}
          onDone={() => onDone(flow, true)}
        />
      );
    case "reopen":
      // "Fix the delivery link" keeps the job Done, so the card waits for the refreshed board instead of moving.
      return <ReopenDialog open onOpenChange={onOpenChange} jobId={job.id} version={job.version} editorName={job.editor?.name ?? null} jobLabel={jobLabel} onConflict={onConflict} onDone={() => onDone(flow, false)} />;
    case "approve": {
      const { job, shareQuestion, selfReviewNeedsConfirm } = flow.card;
      // A job with a question to ask (the self-check confirm, the share question) gets that question
      // straight away — it IS the confirmation. Dismissing it leaves the card where it was.
      if (shareQuestion || selfReviewNeedsConfirm) {
        return (
          <ApproveButton
            autoStart
            jobId={job.id}
            version={job.version}
            clientName={job.client.name}
            shareQuestion={shareQuestion}
            selfReviewNeedsConfirm={selfReviewNeedsConfirm}
            shareableLinks={job.finishedLink ? [job.finishedLink] : []}
            finishedLink={job.finishedLink}
            onConflict={onConflict}
            onDone={() => onDone(flow, true)}
          />
        );
      }
      return <ApproveDropDialog flow={flow} onOpenChange={onOpenChange} onConflict={onConflict} onDone={() => onDone(flow, true)} />;
    }
  }
}

/**
 * A drop on Done for a job with nothing to ask (no portal, not the owner's own edit) confirms
 * first — a drag is easy to do by accident — then hands over to the one Approve button, which
 * finishes the job exactly as on the job page and Home.
 */
function ApproveDropDialog({ flow, onOpenChange, onConflict, onDone }: { flow: Flow; onOpenChange: (open: boolean) => void; onConflict: (error: ApiError) => void; onDone: () => void }) {
  const { job } = flow.card;
  return (
    <Dialog open onOpenChange={onOpenChange} size="sm">
      <DialogHeader>
        <DialogTitle>Approve this job?</DialogTitle>
        <DialogDescription>
          <span className="font-medium text-ink-secondary">
            {job.name} · {job.client.name}.{" "}
          </span>
          It moves to Done.
        </DialogDescription>
      </DialogHeader>
      {job.finishedLink ? (
        <DialogBody className="pb-4">
          <Button variant="outline" size="sm" href={job.finishedLink.url} target="_blank" rel="noopener noreferrer" leadingIcon={<Images aria-hidden="true" />}>
            Open finished photos
          </Button>
        </DialogBody>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <ApproveButton
          jobId={job.id}
          version={job.version}
          clientName={job.client.name}
          shareQuestion={false}
          selfReviewNeedsConfirm={false}
          shareableLinks={job.finishedLink ? [job.finishedLink] : []}
          finishedLink={job.finishedLink}
          onConflict={onConflict}
          onDone={onDone}
        />
      </DialogFooter>
    </Dialog>
  );
}
