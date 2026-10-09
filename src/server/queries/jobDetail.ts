/**
 * Job detail bundle (`GET /api/jobs/:id`, `/jobs/[id]`; ARCHITECTURE.md §10).
 *
 * Redaction per role:
 *  - notes: each kind passes `note.read` (editors never see internal notes;
 *    photographers only on their own jobs);
 *  - work sessions: other people's sessions need `timer.view_others`;
 *  - comments: soft-deleted bodies are blanked (`body: null`).
 * Metrics come from src/lib/metrics.ts; action buttons from
 * `availableActions()` in src/lib/workflow.ts.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { commentMentions, jobAssignments, jobComments, jobLinks, jobNotes, jobRevisions, jobs, workSessions } from "@/db/schema";
import { LINK_KINDS, LINK_KIND_META, NOTE_KINDS, type StatusCategory } from "@/lib/constants";
import { durationSeconds, editingSeconds, reviewSeconds, timeInStage, turnaroundSeconds } from "@/lib/metrics";
import type {
  AssignmentView,
  AuthContext,
  CommentNode,
  Job,
  JobAssignment,
  JobComment,
  JobDetail,
  JobLink,
  JobNote,
  JobPermissionRef,
  JobRevision,
  LinkSlot,
  LinkView,
  NoteView,
  RevisionView,
  UserRef,
  WorkSession,
  WorkSessionView,
} from "@/lib/types";
import { availableActions, toStatusRef } from "@/lib/workflow";
import { can } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { loadTransitions, toStageViews } from "./jobHistory";
import { loadStatusRefs, loadUserRefs, loadVisibleJob, loadWorkflowGraphs, mapJobRows, selectRawJobs, workflowJobOf } from "./scope";

const EDITING_CATEGORIES: readonly StatusCategory[] = ["in_progress", "revision"];

function unknownUser(id: string): UserRef {
  return { id, name: "Unknown user", role: "editor", avatarColour: "#64748b", isActive: false };
}

/* ------------------------------------------------------------------ */
/*  Mappers                                                            */
/* ------------------------------------------------------------------ */

export type UserLookup = (id: string | null | undefined) => UserRef | null;

export function toLinkView(l: JobLink, user: UserLookup): LinkView {
  return {
    id: l.id,
    kind: l.kind,
    url: l.url,
    label: l.label,
    provider: l.provider,
    addedBy: user(l.addedByUserId) ?? unknownUser(l.addedByUserId),
    createdAt: l.createdAt,
    supersedesLinkId: l.supersedesLinkId,
    supersededAt: l.supersededAt,
    supersededByLinkId: l.supersededByLinkId,
    removedAt: l.removedAt,
    removedBy: user(l.removedByUserId),
    removeReason: l.removeReason,
    isCurrent: l.supersededAt === null && l.removedAt === null,
  };
}

/** One slot per supersession chain (root → replacements), ordered by LINK_KINDS then age. */
export function buildLinkSlots(rows: readonly JobLink[], user: UserLookup): LinkSlot[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const roots = rows.filter((r) => r.supersedesLinkId === null || !byId.has(r.supersedesLinkId));
  const slots: (LinkSlot & { rootCreatedAt: string })[] = [];
  for (const root of roots) {
    const chain: JobLink[] = [];
    const seen = new Set<string>();
    let cur: JobLink | undefined = root;
    while (cur && !seen.has(cur.id)) {
      chain.push(cur);
      seen.add(cur.id);
      cur = cur.supersededByLinkId ? byId.get(cur.supersededByLinkId) : undefined;
    }
    const history = chain.map((l) => toLinkView(l, user));
    const last = history[history.length - 1];
    slots.push({ kind: root.kind, current: last?.isCurrent ? last : null, history, rootCreatedAt: root.createdAt });
  }
  slots.sort((a, b) => LINK_KINDS.indexOf(a.kind) - LINK_KINDS.indexOf(b.kind) || a.rootCreatedAt.localeCompare(b.rootCreatedAt));
  return slots.map(({ kind, current, history }) => ({ kind, current, history }));
}

export function toNoteView(n: JobNote, user: UserLookup): NoteView {
  return {
    id: n.id,
    kind: n.kind,
    body: n.body,
    author: user(n.authorUserId) ?? unknownUser(n.authorUserId),
    lastEditedBy: user(n.lastEditedByUserId),
    editCount: n.editCount,
    revisionId: n.revisionId,
    isPinned: n.isPinned,
    archivedAt: n.archivedAt,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    version: n.version,
  };
}

/** Threaded comments (roots oldest first; replies nested under their parent). */
export function buildCommentTree(
  ctx: AuthContext,
  jobRef: JobPermissionRef,
  rows: readonly JobComment[],
  mentions: ReadonlyMap<string, readonly string[]>,
  user: UserLookup,
): CommentNode[] {
  const nodes = new Map<string, CommentNode>();
  for (const c of rows) {
    nodes.set(c.id, {
      id: c.id,
      parentCommentId: c.parentCommentId,
      rootCommentId: c.rootCommentId ?? c.id,
      revisionId: c.revisionId,
      author: user(c.authorUserId) ?? unknownUser(c.authorUserId),
      kind: c.kind,
      body: c.deletedAt ? null : c.body,
      mentions: (mentions.get(c.id) ?? []).map((id) => user(id) ?? unknownUser(id)),
      editedAt: c.editedAt,
      editCount: c.editCount,
      deletedAt: c.deletedAt,
      createdAt: c.createdAt,
      canEdit: can(ctx, "comment.edit", { job: jobRef, authorUserId: c.authorUserId, createdAt: c.createdAt, deletedAt: c.deletedAt }),
      replies: [],
    });
  }
  const roots: CommentNode[] = [];
  for (const c of rows) {
    const node = nodes.get(c.id);
    if (!node) continue;
    const parent = c.parentCommentId ? nodes.get(c.parentCommentId) : undefined;
    if (parent && parent !== node) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}

export function toRevisionView(r: JobRevision, user: UserLookup): RevisionView {
  return {
    id: r.id,
    revisionNumber: r.revisionNumber,
    reason: r.reason,
    description: r.description,
    instructions: r.instructions,
    priority: r.priority,
    dueDate: r.dueDate,
    requestedBy: user(r.requestedByUserId) ?? unknownUser(r.requestedByUserId),
    assignee: user(r.assigneeUserId),
    requestedAt: r.requestedAt,
    resolvedAt: r.resolvedAt,
    resolvedBy: user(r.resolvedByUserId),
    resolution: r.resolution,
    resolutionNote: r.resolutionNote,
    cycleSeconds: r.resolvedAt ? durationSeconds(r.requestedAt, r.resolvedAt, r.resolvedAt) : null,
    isOpen: r.resolvedAt === null,
  };
}

export function toAssignmentView(a: JobAssignment, user: UserLookup): AssignmentView {
  return {
    id: a.id,
    role: a.role,
    user: user(a.userId) ?? unknownUser(a.userId),
    assignedBy: user(a.assignedByUserId),
    assignedAt: a.assignedAt,
    unassignedAt: a.unassignedAt,
    unassignedBy: user(a.unassignedByUserId),
    unassignReason: a.unassignReason,
    reason: a.reason,
    isCurrent: a.unassignedAt === null,
  };
}

export function toWorkSessionView(s: WorkSession, user: UserLookup, statusName: string, now: string): WorkSessionView {
  return {
    id: s.id,
    user: user(s.userId) ?? unknownUser(s.userId),
    statusCategory: s.categoryAtStart,
    statusName,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    endReason: s.endReason,
    durationSeconds: s.endedAt !== null && typeof s.durationSeconds === "number" ? s.durationSeconds : durationSeconds(s.startedAt, s.endedAt, now),
    isRunning: s.endedAt === null,
    note: s.note,
  };
}

/* ------------------------------------------------------------------ */
/*  getJobDetail                                                       */
/* ------------------------------------------------------------------ */

/** Full detail bundle for a visible job; 404 for missing, foreign or not-visible ids. */
export function getJobDetail(db: DbLike, ctx: AuthContext, jobId: string): JobDetail {
  const { job, ref } = loadVisibleJob(db, ctx, jobId, "job.view");
  const now = ctx.now();
  const org = ctx.organisationId;

  const raw = selectRawJobs(db, ctx, { where: eq(jobs.id, job.id), limit: 1 })[0];
  if (!raw) throw new NotFoundError("Job");
  const row = mapJobRows(db, ctx, [raw], now)[0];

  // Ledgers (all org-scoped).
  const linkRows = db
    .select()
    .from(jobLinks)
    .where(and(eq(jobLinks.organisationId, org), eq(jobLinks.jobId, job.id)))
    .orderBy(asc(jobLinks.createdAt), asc(jobLinks.id))
    .all();
  const noteRows = db
    .select()
    .from(jobNotes)
    .where(and(eq(jobNotes.organisationId, org), eq(jobNotes.jobId, job.id)))
    .orderBy(asc(jobNotes.createdAt))
    .all()
    .filter((n) => can(ctx, "note.read", { job: ref, kind: n.kind }));
  const commentRows = db
    .select()
    .from(jobComments)
    .where(and(eq(jobComments.organisationId, org), eq(jobComments.jobId, job.id)))
    .orderBy(asc(jobComments.createdAt), asc(jobComments.id))
    .all();
  const mentionRows =
    commentRows.length === 0
      ? []
      : db
          .select({ commentId: commentMentions.commentId, userId: commentMentions.mentionedUserId })
          .from(commentMentions)
          .where(and(eq(commentMentions.organisationId, org), inArray(commentMentions.commentId, commentRows.map((c) => c.id))))
          .all();
  const revisionRows = db
    .select()
    .from(jobRevisions)
    .where(and(eq(jobRevisions.organisationId, org), eq(jobRevisions.jobId, job.id)))
    .orderBy(asc(jobRevisions.revisionNumber))
    .all();
  const assignmentRows = db
    .select()
    .from(jobAssignments)
    .where(and(eq(jobAssignments.organisationId, org), eq(jobAssignments.jobId, job.id)))
    .orderBy(asc(jobAssignments.assignedAt), asc(jobAssignments.id))
    .all();
  const mayViewOthersTime = can(ctx, "timer.view_others", ref);
  const sessionRows = db
    .select()
    .from(workSessions)
    .where(and(eq(workSessions.organisationId, org), eq(workSessions.jobId, job.id)))
    .orderBy(asc(workSessions.startedAt))
    .all()
    .filter((s) => mayViewOthersTime || s.userId === ctx.userId);
  const transitions = loadTransitions(db, ctx, job.id);

  // People + statuses in two queries.
  const userIds = new Set<string | null>([job.previousEditorId, job.createdByUserId, job.approvedByUserId, job.editorId, job.photographerId]);
  for (const l of linkRows) userIds.add(l.addedByUserId).add(l.removedByUserId);
  for (const n of noteRows) userIds.add(n.authorUserId).add(n.lastEditedByUserId);
  for (const c of commentRows) userIds.add(c.authorUserId);
  for (const m of mentionRows) userIds.add(m.userId);
  for (const r of revisionRows) userIds.add(r.requestedByUserId).add(r.assigneeUserId).add(r.resolvedByUserId);
  for (const a of assignmentRows) userIds.add(a.userId).add(a.assignedByUserId).add(a.unassignedByUserId);
  for (const s of sessionRows) userIds.add(s.userId);
  const users = loadUserRefs(db, ctx, userIds);
  const user: UserLookup = (id) => (id ? (users.get(id) ?? null) : null);
  const statusRefs = loadStatusRefs(db, ctx, [job.previousStatusId, ...sessionRows.map((s) => s.statusIdAtStart)]);

  const graph = loadWorkflowGraphs(db, ctx, [job.workflowId]).get(job.workflowId) ?? { statuses: [], edges: [] };

  // Links.
  const links = buildLinkSlots(linkRows, user);
  const finishedWork = linkRows
    .filter((l) => l.supersededAt === null && l.removedAt === null && LINK_KIND_META[l.kind].finishedWork)
    .map((l) => toLinkView(l, user))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Notes: pinned first, newest first; kinds in NOTE_KINDS order for ties.
  const notes = noteRows
    .map((n) => toNoteView(n, user))
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.createdAt.localeCompare(a.createdAt) || NOTE_KINDS.indexOf(a.kind) - NOTE_KINDS.indexOf(b.kind));

  // Comments.
  const mentionMap = new Map<string, string[]>();
  for (const m of mentionRows) mentionMap.set(m.commentId, [...(mentionMap.get(m.commentId) ?? []), m.userId]);
  const comments = buildCommentTree(ctx, ref, commentRows, mentionMap, user);

  // Revisions, assignments, stages, sessions.
  const revisions = revisionRows.map((r) => toRevisionView(r, user));
  const openRevision = revisions.find((r) => r.isOpen) ?? null;
  const assignments = assignmentRows.map((a) => toAssignmentView(a, user));
  const stages = toStageViews(db, ctx, transitions, now);
  const sessions = sessionRows.map((s) => toWorkSessionView(s, user, statusRefs.get(s.statusIdAtStart)?.name ?? s.categoryAtStart, now));
  const ownRunning = sessions.find((s) => s.isRunning && s.user.id === ctx.userId) ?? null;
  const runningSession = ownRunning ?? sessions.find((s) => s.isRunning) ?? null;

  // Metrics.
  const tracked = ctx.settings.timeTrackingEnabled
    ? sessionRows
        .filter((s) => EDITING_CATEGORIES.includes(s.categoryAtStart))
        .reduce((sum, s) => sum + (s.endedAt !== null && typeof s.durationSeconds === "number" ? s.durationSeconds : durationSeconds(s.startedAt, s.endedAt, now)), 0)
    : null;
  const metrics: JobDetail["metrics"] = {
    turnaroundSeconds: turnaroundSeconds(job, transitions),
    editingSeconds: editingSeconds(transitions, now),
    reviewSeconds: reviewSeconds(transitions, now),
    activeEditingSeconds: tracked,
    timeInCurrentStatusSeconds: durationSeconds(job.statusEnteredAt, null, now),
    secondsPerCategory: timeInStage(transitions, now),
  };

  // Actions.
  const editorIsActive = row.editor ? row.editor.isActive : undefined;
  const actions = availableActions(ctx, workflowJobOf(job, editorIsActive, ref.pastEditorIds), graph.statuses, graph.edges, {
    timeTrackingEnabled: ctx.settings.timeTrackingEnabled,
    openRevision: openRevision !== null,
    hasRunningSession: ownRunning !== null,
  });

  const workflowStatuses = graph.statuses
    .filter((s) => s.archivedAt === null || s.id === job.statusId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(toStatusRef);

  return {
    job: {
      ...row,
      ...detailFields(job, user),
      previousStatus: job.previousStatusId ? (statusRefs.get(job.previousStatusId) ?? null) : null,
    },
    workflowStatuses,
    links,
    finishedWork,
    notes,
    comments,
    revisions,
    openRevision,
    assignments,
    stages,
    sessions,
    runningSession,
    metrics,
    actions,
  };
}

function detailFields(job: Job, user: UserLookup) {
  return {
    description: job.description,
    workflowId: job.workflowId,
    previousEditor: user(job.previousEditorId),
    createdBy: user(job.createdByUserId) ?? unknownUser(job.createdByUserId),
    approvedBy: user(job.approvedByUserId),
    startedAt: job.startedAt,
    firstSubmittedAt: job.firstSubmittedAt,
    lastSubmittedAt: job.lastSubmittedAt,
    approvedAt: job.approvedAt,
    dueDateAtApproval: job.dueDateAtApproval,
    deliveredAt: job.deliveredAt,
    completedAt: job.completedAt,
    dueDateAtCompletion: job.dueDateAtCompletion,
    wasOnTime: job.wasOnTime,
    cancelledAt: job.cancelledAt,
    reopenedCount: job.reopenedCount,
    pausedAt: job.pausedAt,
    updatedAt: job.updatedAt,
  };
}
