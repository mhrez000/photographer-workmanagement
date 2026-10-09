/**
 * Pure workflow-graph helpers (ARCHITECTURE.md §4). No DB access: callers
 * pass the workflow's statuses and edges as plain rows. The workflow service
 * (`src/server/services/workflow.ts`) uses these to resolve targets and check
 * actors; queries use them to build `JobAvailableActions` and kanban
 * `allowedColumns`; the workflow admin uses `validateWorkflowDefinition`.
 */
import {
  CATEGORY_GROUPS,
  KANBAN_COLUMN_META,
  LINK_KINDS,
  NOTE_KINDS,
  ROLES,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_META,
  WORKFLOW_REQUIRED_CATEGORIES,
  type Action,
  type KanbanColumn,
  type KpiBucket,
  type Role,
  type StatusCategory,
} from "@/lib/constants";
import type { AuthContext, JobAvailableActions, JobPermissionRef, StatusRef } from "@/lib/types";
import { AmbiguousTargetError, NotFoundError } from "@/server/errors";
import { can } from "@/server/auth/permissions";

/* ------------------------------------------------------------------ */
/*  Plain row shapes                                                   */
/* ------------------------------------------------------------------ */

export interface StatusLike {
  id: string;
  key: string;
  name: string;
  category: StatusCategory;
  sortOrder: number;
  isInitial: boolean;
  archivedAt: string | null;
  /** Optional: carried into StatusRef when present. */
  colour?: string;
}

export interface EdgeLike {
  id: string;
  fromStatusId: string;
  toStatusId: string;
  allowedRoles: readonly Role[];
  requiresAssignedEditor: boolean;
  assigneeOnly: boolean;
  isReopen: boolean;
  archivedAt: string | null;
  label?: string | null;
}

/** What the workflow helpers need to know about a job. */
export interface WorkflowJobLike extends JobPermissionRef {
  statusId: string;
  /** Status before the current one (= from_status_id of the open transition). Used for restore. */
  previousStatusId?: string | null;
  /** false when the current editor has been deactivated. Defaults to true when editorId is set. */
  editorIsActive?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Category groups                                                    */
/* ------------------------------------------------------------------ */

export const isActiveCategory = (c: StatusCategory): boolean => CATEGORY_GROUPS.ACTIVE.includes(c);
export const isTerminal = (c: StatusCategory): boolean => CATEGORY_GROUPS.TERMINAL.includes(c);
export const isDone = (c: StatusCategory): boolean => CATEGORY_GROUPS.DONE.includes(c);
export const isDeadlineBound = (c: StatusCategory): boolean => CATEGORY_GROUPS.DEADLINE_BOUND.includes(c);
export const isEditorHolds = (c: StatusCategory): boolean => CATEGORY_GROUPS.EDITOR_HOLDS.includes(c);
export const isReviewerHolds = (c: StatusCategory): boolean => CATEGORY_GROUPS.REVIEWER_HOLDS.includes(c);
export const isAwaitingEditor = (c: StatusCategory): boolean => CATEGORY_GROUPS.AWAITING_EDITOR.includes(c);
export const isUnassignedCategory = (c: StatusCategory): boolean => CATEGORY_GROUPS.UNASSIGNED.includes(c);
export const isEditorWorking = (c: StatusCategory): boolean => CATEGORY_GROUPS.EDITOR_WORKING.includes(c);
export const isWorkloadCategory = (c: StatusCategory): boolean => CATEGORY_GROUPS.WORKLOAD.includes(c);

export function kpiBucketOf(category: StatusCategory): KpiBucket {
  return STATUS_CATEGORY_META[category].kpiBucket;
}

export function kanbanColumnOf(category: StatusCategory): KanbanColumn | null {
  return STATUS_CATEGORY_META[category].kanbanColumn;
}

/** Categories that need an active editor on the job (§4.3 step 5). */
export const EDITOR_REQUIRED_CATEGORIES: readonly StatusCategory[] = ["assigned", "accepted", "in_progress", "revision", "resubmitted"];

/* ------------------------------------------------------------------ */
/*  Lookups                                                            */
/* ------------------------------------------------------------------ */

const live = <T extends { archivedAt: string | null }>(rows: readonly T[]): T[] => rows.filter((r) => r.archivedAt === null);

const categoryIndex = (c: StatusCategory): number => STATUS_CATEGORIES.indexOf(c);

function byCategoryThenOrder(a: StatusLike, b: StatusLike): number {
  return categoryIndex(a.category) - categoryIndex(b.category) || a.sortOrder - b.sortOrder;
}

export function categoryOf(statuses: readonly StatusLike[], statusId: string): StatusCategory | null {
  return statuses.find((s) => s.id === statusId)?.category ?? null;
}

export function toStatusRef(s: StatusLike): StatusRef {
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    category: s.category,
    colour: s.colour ?? STATUS_CATEGORY_META[s.category].hex,
    sortOrder: s.sortOrder,
  };
}

/**
 * Resolves a transition target inside one workflow (§4.3 step 1).
 * - by id: must be one of `statuses` and not archived, else NotFoundError (foreign ids look missing).
 * - by category: the non-archived status with the lowest sortOrder. Several
 *   statuses tied at that sortOrder → AmbiguousTargetError. With
 *   `mode: "strict"` any category holding several statuses is ambiguous.
 */
export function resolveTargetStatus(
  statuses: readonly StatusLike[],
  target: { toStatusId?: string | null; toCategory?: StatusCategory | null },
  mode: "lowest" | "strict" = "lowest",
): StatusLike {
  if (target.toStatusId) {
    const s = statuses.find((x) => x.id === target.toStatusId);
    if (!s || s.archivedAt !== null) throw new NotFoundError("Status");
    return s;
  }
  if (!target.toCategory) throw new NotFoundError("Status");
  const candidates = live(statuses)
    .filter((s) => s.category === target.toCategory)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  if (candidates.length === 0) throw new NotFoundError("Status", `This workflow has no status in category "${target.toCategory}"`);
  const tied = mode === "strict" ? candidates : candidates.filter((s) => s.sortOrder === candidates[0].sortOrder);
  if (tied.length > 1) throw new AmbiguousTargetError(tied.map((s) => ({ id: s.id, name: s.name, key: s.key })));
  return candidates[0];
}

/** The non-archived edge from → to, if any. */
export function findEdge(edges: readonly EdgeLike[], fromStatusId: string, toStatusId: string): EdgeLike | undefined {
  return edges.find((e) => e.archivedAt === null && e.fromStatusId === fromStatusId && e.toStatusId === toStatusId);
}

/** Move between two different statuses of the same category (no edge needed, §4.3 step 3). */
export function isLateral(from: Pick<StatusLike, "id" | "category">, to: Pick<StatusLike, "id" | "category">): boolean {
  return from.id !== to.id && from.category === to.category;
}

/** The cancelled status a cancel lands on (lowest sortOrder), if the workflow has one. */
export function cancelTargetOf(statuses: readonly StatusLike[]): StatusLike | undefined {
  return live(statuses)
    .filter((s) => s.category === "cancelled")
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
}

/** Restore target for a cancelled job: the status it was cancelled from, else the initial status. */
export function restoreTargetOf(statuses: readonly StatusLike[], previousStatusId: string | null | undefined): StatusLike | undefined {
  const prev = previousStatusId ? statuses.find((s) => s.id === previousStatusId) : undefined;
  if (prev && prev.archivedAt === null && prev.category !== "cancelled") return prev;
  return live(statuses).find((s) => s.isInitial);
}

/** Synthetic `→ cancelled` edge for every active non-archived status (seeded into workflow_transitions). */
export function generateCancelEdges(statuses: readonly StatusLike[]): EdgeLike[] {
  const target = cancelTargetOf(statuses);
  if (!target) return [];
  return live(statuses)
    .filter((s) => isActiveCategory(s.category))
    .map((s) => ({
      id: `generated-cancel:${s.id}`,
      fromStatusId: s.id,
      toStatusId: target.id,
      allowedRoles: ["owner", "manager", "photographer"] as Role[],
      requiresAssignedEditor: false,
      assigneeOnly: false,
      isReopen: false,
      archivedAt: null,
      label: "Cancel",
    }));
}

/* ------------------------------------------------------------------ */
/*  Actor checks                                                       */
/* ------------------------------------------------------------------ */

function editorActive(job: WorkflowJobLike): boolean {
  return job.editorId !== null && job.editorIsActive !== false;
}

/**
 * Why the actor may not take `edge` on `job` (§4.3 step 4), or null when allowed.
 * Role ∈ allowedRoles; photographer → own; editor → assigned (and current
 * editor when `assigneeOnly`); `requiresAssignedEditor` → active editor set.
 */
export function edgeDenialReason(ctx: AuthContext, job: WorkflowJobLike, edge: EdgeLike): string | null {
  if (edge.archivedAt !== null) return "This transition has been archived";
  if (edge.requiresAssignedEditor && !editorActive(job)) return "Assign an active editor first";
  if (ctx.isSystem) return can(ctx, "job.transition", job) ? null : "Not permitted";
  if (!edge.allowedRoles.includes(ctx.role)) return "Your role cannot make this change";
  if (!can(ctx, "job.transition", job)) {
    return ctx.role === "editor" ? "Only the assigned editor can do this" : "Only the job's photographer or a manager can do this";
  }
  if (edge.assigneeOnly && ctx.role === "editor" && job.editorId !== ctx.userId) return "Only the assigned editor can do this";
  return null;
}

export function actorMayTakeEdge(ctx: AuthContext, job: WorkflowJobLike, edge: EdgeLike): boolean {
  return edgeDenialReason(ctx, job, edge) === null;
}

/**
 * The specific matrix action that guards an edge (§3.2), on top of
 * `job.transition`. `null` = engine-internal (performed through the
 * assignment service, never offered as a button).
 */
export function actionForMove(ctx: Pick<AuthContext, "role">, from: StatusCategory, to: StatusCategory, isReopen: boolean): Action | null {
  if (isReopen || (from === "completed" && to !== "completed")) return "job.reopen";
  switch (to) {
    case "cancelled":
      return "job.cancel";
    case "assigned":
      return null; // side effect of assignEditor
    case "ready":
      if (from === "assigned" && ctx.role === "editor") return "job.decline";
      return isEditorHolds(from) ? null : "job.transition"; // unassign is engine-internal
    case "new":
      return "job.transition";
    case "accepted":
      return "job.accept";
    case "in_progress":
      return "job.start";
    case "submitted":
      return "job.submit";
    case "review":
      return "job.begin_review";
    case "revision":
      return "revision.request";
    case "resubmitted":
      return "revision.resolve";
    case "approved":
      return "job.approve";
    case "delivered":
      return "job.deliver";
    case "completed":
      return "job.complete";
    default:
      return "job.transition";
  }
}

/* ------------------------------------------------------------------ */
/*  Allowed transitions / available actions                            */
/* ------------------------------------------------------------------ */

/** Button labels keyed by `${fromCategory}>${toCategory}`; falls back to TARGET_LABELS. */
export const TRANSITION_LABELS: Readonly<Record<string, string>> = {
  "new>ready": "Mark ready",
  "ready>new": "Back to draft",
  "assigned>accepted": "Accept",
  "assigned>in_progress": "Start",
  "assigned>ready": "Decline",
  "accepted>in_progress": "Start",
  "in_progress>submitted": "Submit for review",
  "submitted>review": "Begin review",
  "resubmitted>review": "Begin review",
  "submitted>revision": "Request revision",
  "review>revision": "Request revision",
  "resubmitted>revision": "Request another revision",
  "submitted>approved": "Approve",
  "review>approved": "Approve",
  "resubmitted>approved": "Approve",
  "revision>resubmitted": "Resubmit",
  "approved>delivered": "Deliver",
  "approved>completed": "Complete",
  "delivered>completed": "Complete",
  "approved>revision": "Un-approve (revision)",
  "delivered>revision": "Client bounce (revision)",
  "completed>revision": "Reopen for revision",
  "completed>in_progress": "Reopen",
  "completed>approved": "Reopen (fix delivery)",
  "cancelled>*": "Restore",
};

const TARGET_LABELS: Record<StatusCategory, string> = {
  new: "Back to new",
  ready: "Mark ready",
  assigned: "Assign",
  accepted: "Accept",
  in_progress: "Start",
  submitted: "Submit for review",
  review: "Begin review",
  revision: "Request revision",
  resubmitted: "Resubmit",
  approved: "Approve",
  delivered: "Deliver",
  completed: "Complete",
  cancelled: "Cancel",
};

export function transitionLabel(from: StatusCategory, to: StatusCategory, isReopen: boolean): string {
  if (from === "cancelled") return TRANSITION_LABELS["cancelled>*"];
  const exact = TRANSITION_LABELS[`${from}>${to}`];
  if (exact) return exact;
  if (isReopen) return "Reopen";
  return TARGET_LABELS[to];
}

/** One allowed move for the actor, with the edge it uses (null = restore / lateral / generated cancel). */
export interface AllowedMove {
  toStatus: StatusLike;
  edge: EdgeLike | null;
  label: string;
  isReopen: boolean;
  isRestore: boolean;
  isLateral: boolean;
  requiresRevisionPayload: boolean;
  requiresReason: boolean;
}

function moveFlags(to: StatusLike, isReopen: boolean) {
  return {
    requiresRevisionPayload: to.category === "revision",
    requiresReason: to.category === "cancelled" || isReopen,
  };
}

/** Whether the actor could enter `category` through any edge of the workflow (lateral rule). */
function mayEnterCategory(ctx: AuthContext, job: WorkflowJobLike, category: StatusCategory, statuses: readonly StatusLike[], edges: readonly EdgeLike[]): boolean {
  const ids = new Set(statuses.filter((s) => s.category === category).map((s) => s.id));
  return live(edges).some((e) => {
    if (!ids.has(e.toStatusId)) return false;
    const from = statuses.find((s) => s.id === e.fromStatusId);
    if (!from || from.category === category) return false;
    const action = actionForMove(ctx, from.category, category, e.isReopen);
    return action !== null && actorMayTakeEdge(ctx, job, e) && can(ctx, action, job);
  });
}

/**
 * Every move the actor may make from the job's current status, ordered by
 * category then sortOrder. Includes explicit edges, the generated cancel edge,
 * lateral same-category moves and (for cancelled jobs) the computed restore.
 * Engine-internal edges (→ assigned, unassign → ready) are excluded.
 */
export function allowedMoves(ctx: AuthContext, job: WorkflowJobLike, statuses: readonly StatusLike[], edges: readonly EdgeLike[]): AllowedMove[] {
  const current = statuses.find((s) => s.id === job.statusId);
  if (!current) return [];

  if (current.category === "cancelled") {
    const target = restoreTargetOf(statuses, job.previousStatusId);
    if (!target || !can(ctx, "job.restore", job)) return [];
    return [{ toStatus: target, edge: null, label: "Restore", isReopen: false, isRestore: true, isLateral: false, requiresRevisionPayload: false, requiresReason: false }];
  }

  const moves: AllowedMove[] = [];
  const seen = new Set<string>();
  const statusById = new Map(statuses.map((s) => [s.id, s]));

  for (const edge of live(edges)) {
    if (edge.fromStatusId !== current.id) continue;
    const to = statusById.get(edge.toStatusId);
    if (!to || to.archivedAt !== null || seen.has(to.id)) continue;
    const action = actionForMove(ctx, current.category, to.category, edge.isReopen);
    if (action === null || !actorMayTakeEdge(ctx, job, edge) || !can(ctx, action, job)) continue;
    const isReopen = edge.isReopen || (current.category === "completed" && to.category !== "completed");
    seen.add(to.id);
    moves.push({
      toStatus: to,
      edge,
      label: isLateral(current, to) ? `Move to ${to.name}` : transitionLabel(current.category, to.category, isReopen),
      isReopen,
      isRestore: false,
      isLateral: isLateral(current, to),
      ...moveFlags(to, isReopen),
    });
  }

  // Generated cancel edge (when the workflow has no explicit one from here).
  const cancel = cancelTargetOf(statuses);
  if (cancel && !seen.has(cancel.id) && isActiveCategory(current.category) && can(ctx, "job.cancel", job)) {
    seen.add(cancel.id);
    moves.push({ toStatus: cancel, edge: null, label: "Cancel", isReopen: false, isRestore: false, isLateral: false, ...moveFlags(cancel, false) });
  }

  // Lateral moves within the current category need no edge.
  const siblings = live(statuses).filter((s) => isLateral(current, s) && !seen.has(s.id));
  if (siblings.length > 0 && current.category !== "completed" && mayEnterCategory(ctx, job, current.category, statuses, edges)) {
    for (const s of siblings) {
      seen.add(s.id);
      moves.push({ toStatus: s, edge: null, label: `Move to ${s.name}`, isReopen: false, isRestore: false, isLateral: true, ...moveFlags(s, false) });
    }
  }

  moves.sort((a, b) => byCategoryThenOrder(a.toStatus, b.toStatus));

  // Disambiguate duplicate labels ("Start (Rough Cut)" / "Start (Final Cut)").
  const counts = new Map<string, number>();
  for (const m of moves) counts.set(m.label, (counts.get(m.label) ?? 0) + 1);
  return moves.map((m) => ((counts.get(m.label) ?? 0) > 1 && !m.isLateral ? { ...m, label: `${m.label} (${m.toStatus.name})` } : m));
}

/** `JobAvailableActions.transitions` for the actor. */
export function allowedTransitions(
  ctx: AuthContext,
  job: WorkflowJobLike,
  statuses: readonly StatusLike[],
  edges: readonly EdgeLike[],
): JobAvailableActions["transitions"] {
  return allowedMoves(ctx, job, statuses, edges).map((m) => ({
    toStatus: toStatusRef(m.toStatus),
    label: m.label,
    isReopen: m.isReopen,
    requiresRevisionPayload: m.requiresRevisionPayload,
    requiresReason: m.requiresReason,
  }));
}

export interface AvailableActionsExtras {
  timeTrackingEnabled: boolean;
  /** The job has an open revision. */
  openRevision: boolean;
  /** The actor has a running work session on this job. */
  hasRunningSession: boolean;
}

/** Full set of action buttons for the job detail header (§10). */
export function availableActions(
  ctx: AuthContext,
  job: WorkflowJobLike,
  statuses: readonly StatusLike[],
  edges: readonly EdgeLike[],
  extras: AvailableActionsExtras,
): JobAvailableActions {
  const moves = allowedMoves(ctx, job, statuses, edges);
  const category = job.statusCategory;
  return {
    transitions: allowedTransitions(ctx, job, statuses, edges),
    canEditFields: can(ctx, "job.edit_fields", job),
    canEditDeadlines: can(ctx, "job.set_due_date", job),
    canSetPriority: can(ctx, "job.set_priority", job),
    canAssignEditor: category !== "cancelled" && can(ctx, "job.assign_editor", job),
    canAssignPhotographer: category !== "cancelled" && can(ctx, "job.assign_photographer", job),
    canCancel: moves.some((m) => m.toStatus.category === "cancelled"),
    canRestore: moves.some((m) => m.isRestore),
    canPause: !job.isPaused && can(ctx, "job.pause", job),
    canResume: job.isPaused && can(ctx, "job.pause", job),
    canAddLinkKinds: LINK_KINDS.filter((kind) => can(ctx, "link.add", { job, kind })),
    canAddNoteKinds: NOTE_KINDS.filter((kind) => can(ctx, "note.add", { job, kind })),
    canComment: can(ctx, "comment.add", job),
    canUseTimer: extras.timeTrackingEnabled && (extras.hasRunningSession || can(ctx, "timer.use", job)),
    canRequestRevision: moves.some((m) => m.requiresRevisionPayload && !m.isReopen),
    canWithdrawRevision: extras.openRevision && can(ctx, "revision.withdraw", job),
  };
}

/* ------------------------------------------------------------------ */
/*  Kanban drop (§4.6)                                                 */
/* ------------------------------------------------------------------ */

export type KanbanDropResult =
  | { kind: "noop" }
  | { kind: "single"; toStatus: StatusLike; edge: EdgeLike | null; move: AllowedMove }
  | { kind: "ambiguous"; candidates: AllowedMove[] }
  | { kind: "none"; reason: string };

export function resolveKanbanDrop(
  ctx: AuthContext,
  job: WorkflowJobLike,
  column: KanbanColumn,
  statuses: readonly StatusLike[],
  edges: readonly EdgeLike[],
): KanbanDropResult {
  const meta = KANBAN_COLUMN_META[column];
  // (4) already in the column → no-op
  if (meta.categories.includes(job.statusCategory)) return { kind: "noop" };
  // (1)(2) candidate statuses in column order
  const inColumn = live(statuses)
    .filter((s) => meta.categories.includes(s.category))
    .sort((a, b) => meta.categories.indexOf(a.category) - meta.categories.indexOf(b.category) || a.sortOrder - b.sortOrder);
  if (inColumn.length === 0) return { kind: "none", reason: `This workflow has no ${meta.label} status` };
  // (3) keep those the actor may move to
  const columnIds = new Set(inColumn.map((s) => s.id));
  const candidates = allowedMoves(ctx, job, statuses, edges)
    .filter((m) => columnIds.has(m.toStatus.id))
    .sort((a, b) => meta.categories.indexOf(a.toStatus.category) - meta.categories.indexOf(b.toStatus.category) || a.toStatus.sortOrder - b.toStatus.sortOrder);
  if (candidates.length === 1) return { kind: "single", toStatus: candidates[0].toStatus, edge: candidates[0].edge, move: candidates[0] };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "none", reason: explainNoMove(ctx, job, inColumn, statuses, edges, meta.label) };
}

function explainNoMove(
  ctx: AuthContext,
  job: WorkflowJobLike,
  targets: readonly StatusLike[],
  statuses: readonly StatusLike[],
  edges: readonly EdgeLike[],
  columnLabel: string,
): string {
  const current = statuses.find((s) => s.id === job.statusId);
  const currentName = current?.name ?? "the current status";
  if (targets.some((t) => t.category === "assigned")) {
    if (job.editorId === null) return "Assign an editor to move this job to Assigned";
  }
  for (const t of targets) {
    const edge = current ? findEdge(edges, current.id, t.id) : undefined;
    if (!edge) continue;
    const reason = edgeDenialReason(ctx, job, edge);
    if (reason) return reason;
    if (current) {
      const action = actionForMove(ctx, current.category, t.category, edge.isReopen);
      if (action === null) return `${t.name} is set by assigning or unassigning an editor`;
      if (!can(ctx, action, job)) return "You do not have permission to make this change";
    }
  }
  return `Cannot move from "${currentName}" to ${columnLabel}`;
}

/** Kanban columns the actor may drop the card into (KanbanCard.allowedColumns). */
export function allowedKanbanColumns(ctx: AuthContext, job: WorkflowJobLike, statuses: readonly StatusLike[], edges: readonly EdgeLike[]): KanbanColumn[] {
  const cols = new Set<KanbanColumn>();
  for (const m of allowedMoves(ctx, job, statuses, edges)) {
    const col = kanbanColumnOf(m.toStatus.category);
    if (col && !KANBAN_COLUMN_META[col].categories.includes(job.statusCategory)) cols.add(col);
  }
  return [...cols];
}

/* ------------------------------------------------------------------ */
/*  Workflow definition validation (§4.6)                              */
/* ------------------------------------------------------------------ */

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Returns human-readable problems; empty array = valid. Archived rows are ignored. */
export function validateWorkflowDefinition(statuses: readonly StatusLike[], edges: readonly EdgeLike[]): string[] {
  const problems: string[] = [];
  const active = live(statuses);
  const activeEdges = live(edges);
  const byId = new Map(active.map((s) => [s.id, s]));

  // exactly one initial, category new
  const initials = active.filter((s) => s.isInitial);
  if (initials.length !== 1) problems.push(`Exactly one initial status is required (found ${initials.length})`);
  for (const s of initials) {
    if (s.category !== "new") problems.push(`Initial status "${s.name}" must be in category "new"`);
  }

  // required categories
  for (const c of WORKFLOW_REQUIRED_CATEGORIES) {
    if (!active.some((s) => s.category === c)) problems.push(`Missing a status in required category "${c}"`);
  }

  // keys: unique + slug; names unique
  const keys = new Map<string, number>();
  const names = new Map<string, number>();
  for (const s of active) {
    if (!KEY_PATTERN.test(s.key)) problems.push(`Status key "${s.key}" must be a lowercase slug (a-z, 0-9, _)`);
    keys.set(s.key, (keys.get(s.key) ?? 0) + 1);
    const n = s.name.trim().toLowerCase();
    names.set(n, (names.get(n) ?? 0) + 1);
  }
  for (const [k, n] of keys) if (n > 1) problems.push(`Status key "${k}" is used ${n} times`);
  for (const s of active) {
    if ((names.get(s.name.trim().toLowerCase()) ?? 0) > 1 && active.find((x) => x.name.trim().toLowerCase() === s.name.trim().toLowerCase()) === s) {
      problems.push(`Status name "${s.name}" is used more than once`);
    }
  }

  // edges: endpoints, roles, duplicates, self-loops
  const pairs = new Set<string>();
  for (const e of activeEdges) {
    const from = byId.get(e.fromStatusId);
    const to = byId.get(e.toStatusId);
    if (!from || !to) {
      problems.push(`Transition ${e.id} references a missing or archived status`);
      continue;
    }
    if (from.id === to.id) problems.push(`Transition "${from.name}" → itself is not allowed`);
    if (e.allowedRoles.length === 0) problems.push(`Transition "${from.name}" → "${to.name}" must allow at least one role`);
    for (const r of e.allowedRoles) {
      if (!(ROLES as readonly string[]).includes(r)) problems.push(`Transition "${from.name}" → "${to.name}" has unknown role "${r}"`);
    }
    const pair = `${from.id}>${to.id}`;
    if (pairs.has(pair)) problems.push(`Duplicate transition "${from.name}" → "${to.name}"`);
    pairs.add(pair);
  }

  // every non-terminal status needs an outgoing edge (cancel edges do not count)
  for (const s of active) {
    if (isTerminal(s.category)) continue;
    const out = activeEdges.some((e) => e.fromStatusId === s.id && byId.has(e.toStatusId) && byId.get(e.toStatusId)?.category !== "cancelled");
    if (!out) problems.push(`Status "${s.name}" has no outgoing transition`);
  }

  // reachability from the initial status (generated cancel edges included)
  if (initials.length === 1) {
    const adj = new Map<string, string[]>();
    for (const e of [...activeEdges, ...generateCancelEdges(active)]) {
      if (!byId.has(e.fromStatusId) || !byId.has(e.toStatusId)) continue;
      adj.set(e.fromStatusId, [...(adj.get(e.fromStatusId) ?? []), e.toStatusId]);
    }
    const seen = new Set<string>([initials[0].id]);
    const queue = [initials[0].id];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const next of adj.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const s of active) {
      if (!seen.has(s.id)) problems.push(`Status "${s.name}" is not reachable from the initial status`);
    }
  }

  return problems;
}
