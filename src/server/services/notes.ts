/**
 * Job notes (ARCHITECTURE.md §2.4 job_notes, §3.2 note rows, §5 note.* events).
 *
 * Notes are edited in place; every change is audited (`note.edited` carries
 * the previous and new body), so the history drawer is rebuilt from events
 * (`noteHistory`). Internal notes produce management-only events
 * (recordEvent upgrades visibility when `kind = internal`).
 *
 * Permissions (permissions.ts): `note.add/edit/archive` — owners/managers any
 * kind; photographers on own jobs, kinds photographer/client/revision;
 * editors on assigned jobs, kinds editor/revision, edit/archive own notes
 * only. `note.read` — editors never see internal notes; photographers see
 * internal notes on their own jobs only. Restore uses `note.archive`.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { first, one, type DbLike, type Tx } from "@/db/index";
import { activityEvents, jobNotes, type Json } from "@/db/schema";
import { NOTE_KINDS, type NoteKind } from "@/lib/constants";
import type { AuthContext, JobNote, JobPermissionRef, NoteHistoryEntry, NoteView } from "@/lib/types";
import { AddNoteInput, ArchiveNoteInput, EditNoteInput, RestoreNoteInput } from "@/lib/validation/notes";
import { assertCan, can, type NotePermissionRef } from "@/server/auth/permissions";
import { recordEvent } from "@/server/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { jobMeta, loadJobWithRef, loadUserRefMap, unknownUserRef } from "./_collab";
import { assertVersion, loadNoteInOrg, loadRevisionInOrg, loadUserInOrg, parseInput } from "./_shared";

function noteRef(ref: JobPermissionRef, note: Pick<JobNote, "kind" | "authorUserId">): NotePermissionRef {
  return { job: ref, kind: note.kind, authorUserId: note.authorUserId };
}

/** Optimistic-concurrency update: `version + 1` where the version still matches, else 409. */
async function updateNote(tx: Tx, ctx: AuthContext, note: JobNote, set: Partial<typeof jobNotes.$inferInsert>): Promise<JobNote> {
  const updated = await first(
    tx
      .update(jobNotes)
      .set({ ...set, updatedAt: ctx.now(), version: note.version + 1 })
      .where(and(eq(jobNotes.id, note.id), eq(jobNotes.organisationId, ctx.organisationId), eq(jobNotes.version, note.version)))
      .returning(),
  );
  if (!updated) throw new ConflictError(undefined, await loadNoteInOrg(tx, ctx, note.id));
  return updated;
}

/* ------------------------------------------------------------------ */
/*  addNote                                                            */
/* ------------------------------------------------------------------ */

/**
 * Adds a note. `kind = revision` links the note to `revisionId` (default:
 * the job's open revision). The system context (automation `add_note`) may
 * name an author via `authorUserId` (default: the job's creator).
 */
export async function addNote(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobNote> {
  const data = parseInput(AddNoteInput, input);
  const { job, ref } = await loadJobWithRef(tx, ctx, data.jobId);
  assertCan(ctx, "note.add", { job: ref, kind: data.kind });

  let authorUserId: string;
  if (ctx.userId) {
    authorUserId = ctx.userId;
  } else {
    const author = await loadUserInOrg(tx, ctx, data.authorUserId ?? job.createdByUserId);
    authorUserId = author.id;
  }

  let revisionId: string | null = null;
  if (data.kind === "revision") {
    const wanted = data.revisionId ?? job.openRevisionId;
    if (wanted) {
      const revision = await loadRevisionInOrg(tx, ctx, wanted);
      if (revision.jobId !== job.id) throw new NotFoundError("Revision");
      revisionId = revision.id;
    }
  }

  const at = ctx.now();
  const note = await one(
    tx
      .insert(jobNotes)
      .values({
        organisationId: ctx.organisationId,
        jobId: job.id,
        kind: data.kind,
        body: data.body,
        authorUserId,
        revisionId,
        isPinned: data.isPinned,
        createdAt: at,
        updatedAt: at,
      })
      .returning(),
    "note",
  );

  await recordEvent(tx, ctx, {
    entityType: "note",
    entityId: note.id,
    jobId: job.id,
    eventType: "note.added",
    action: "created",
    previousValue: null,
    newValue: { kind: note.kind, body: note.body, revisionId: note.revisionId, isPinned: note.isPinned },
    metadata: { noteId: note.id, editCount: 0, ...jobMeta(job) },
  });
  return note;
}

/* ------------------------------------------------------------------ */
/*  editNote / archiveNote / restoreNote                               */
/* ------------------------------------------------------------------ */

/**
 * Edits a note's body and/or pin. Body changes bump `edit_count` and set
 * `last_edited_by_user_id`; every change writes `note.edited` with before/after.
 * Archived notes must be restored first. Unchanged input is a no-op.
 */
export async function editNote(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobNote> {
  const data = parseInput(EditNoteInput, input);
  const note = await loadNoteInOrg(tx, ctx, data.noteId);
  const { job, ref } = await loadJobWithRef(tx, ctx, note.jobId);
  assertCan(ctx, "note.edit", noteRef(ref, note));
  assertVersion(note, data.expectedVersion);
  if (note.archivedAt) throw new ValidationError("Restore the note before editing it");

  const bodyChanged = data.body !== undefined && data.body !== note.body;
  const pinChanged = data.isPinned !== undefined && data.isPinned !== note.isPinned;
  if (!bodyChanged && !pinChanged) return note;

  const updated = await updateNote(tx, ctx, note, {
    ...(bodyChanged ? { body: data.body, lastEditedByUserId: ctx.userId, editCount: note.editCount + 1 } : {}),
    ...(pinChanged ? { isPinned: data.isPinned } : {}),
  });

  await recordEvent(tx, ctx, {
    entityType: "note",
    entityId: note.id,
    jobId: job.id,
    eventType: "note.edited",
    action: "updated",
    previousValue: { kind: note.kind, body: note.body, ...(pinChanged ? { isPinned: note.isPinned } : {}) },
    newValue: { kind: updated.kind, body: updated.body, ...(pinChanged ? { isPinned: updated.isPinned } : {}) },
    metadata: { noteId: note.id, editCount: updated.editCount, ...jobMeta(job) },
  });
  return updated;
}

/** Archives a note (hidden from the Notes tab by default). Already archived → no-op. */
export async function archiveNote(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobNote> {
  const data = parseInput(ArchiveNoteInput, input);
  const note = await loadNoteInOrg(tx, ctx, data.noteId);
  const { job, ref } = await loadJobWithRef(tx, ctx, note.jobId);
  assertCan(ctx, "note.archive", noteRef(ref, note));
  if (data.expectedVersion !== undefined) assertVersion(note, data.expectedVersion);
  if (note.archivedAt) return note;

  const archivedAt = ctx.now();
  const updated = await updateNote(tx, ctx, note, { archivedAt, archivedByUserId: ctx.userId });
  await recordEvent(tx, ctx, {
    entityType: "note",
    entityId: note.id,
    jobId: job.id,
    eventType: "note.archived",
    action: "archived",
    previousValue: { kind: note.kind, body: note.body, archivedAt: null },
    newValue: { kind: note.kind, body: note.body, archivedAt },
    metadata: { noteId: note.id, editCount: note.editCount, ...jobMeta(job) },
  });
  return updated;
}

/** Restores an archived note (permission `note.archive`). Not archived → no-op. */
export async function restoreNote(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobNote> {
  const data = parseInput(RestoreNoteInput, input);
  const note = await loadNoteInOrg(tx, ctx, data.noteId);
  const { job, ref } = await loadJobWithRef(tx, ctx, note.jobId);
  assertCan(ctx, "note.archive", noteRef(ref, note));
  if (data.expectedVersion !== undefined) assertVersion(note, data.expectedVersion);
  if (!note.archivedAt) return note;

  const updated = await updateNote(tx, ctx, note, { archivedAt: null, archivedByUserId: null });
  await recordEvent(tx, ctx, {
    entityType: "note",
    entityId: note.id,
    jobId: job.id,
    eventType: "note.restored",
    action: "restored",
    previousValue: { kind: note.kind, archivedAt: note.archivedAt },
    newValue: { kind: note.kind, body: note.body, archivedAt: null },
    metadata: { noteId: note.id, editCount: note.editCount, ...jobMeta(job) },
  });
  return updated;
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

const KIND_ORDER = new Map<NoteKind, number>(NOTE_KINDS.map((k, i) => [k, i]));

/**
 * Notes of a job the actor may read (`note.read` per kind), pinned first,
 * then by kind order, then oldest first. Archived notes only with
 * `includeArchived`.
 */
export async function listNotes(
  db: DbLike,
  ctx: AuthContext,
  jobId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<NoteView[]> {
  const { job, ref } = await loadJobWithRef(db, ctx, jobId);
  assertCan(ctx, "job.view", ref);
  const rows = (
    await db
      .select()
      .from(jobNotes)
      .where(
        and(
          eq(jobNotes.jobId, job.id),
          eq(jobNotes.organisationId, ctx.organisationId),
          opts.includeArchived ? undefined : isNull(jobNotes.archivedAt),
        ),
      )
      .orderBy(asc(jobNotes.createdAt), asc(jobNotes.id))
  ).filter((n) => can(ctx, "note.read", { job: ref, kind: n.kind }));

  const people = await loadUserRefMap(db, ctx, rows.flatMap((n) => [n.authorUserId, n.lastEditedByUserId]));
  const views = rows.map<NoteView>((n) => ({
    id: n.id,
    kind: n.kind,
    body: n.body,
    author: people.get(n.authorUserId) ?? unknownUserRef(n.authorUserId),
    lastEditedBy: n.lastEditedByUserId ? (people.get(n.lastEditedByUserId) ?? unknownUserRef(n.lastEditedByUserId)) : null,
    editCount: n.editCount,
    revisionId: n.revisionId,
    isPinned: n.isPinned,
    archivedAt: n.archivedAt,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    version: n.version,
  }));
  return views.sort(
    (a, b) =>
      Number(b.isPinned) - Number(a.isPinned) ||
      (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

function bodyOf(value: Json | null): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const body = (value as Record<string, Json>).body;
    return typeof body === "string" ? body : null;
  }
  return null;
}

function editCountOf(value: Json | null): number | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const n = (value as Record<string, Json>).editCount;
    return typeof n === "number" ? n : null;
  }
  return null;
}

const HISTORY_TYPES = new Set<string>(["note.added", "note.edited", "note.archived", "note.restored"]);

/**
 * A note's history drawer, oldest first, read from its `note.*` activity
 * events (the only record of prior bodies). Permission: `note.read`.
 */
export async function noteHistory(db: DbLike, ctx: AuthContext, noteId: string): Promise<NoteHistoryEntry[]> {
  const note = await loadNoteInOrg(db, ctx, noteId);
  const { ref } = await loadJobWithRef(db, ctx, note.jobId);
  assertCan(ctx, "note.read", noteRef(ref, note));

  const events = (
    await db
      .select()
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.organisationId, ctx.organisationId),
          eq(activityEvents.entityType, "note"),
          eq(activityEvents.entityId, note.id),
        ),
      )
      .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid))
  ).filter((e) => HISTORY_TYPES.has(e.eventType));

  const people = await loadUserRefMap(db, ctx, events.map((e) => e.actorUserId));

  return events.map<NoteHistoryEntry>((e) => ({
    eventId: e.id,
    eventType: e.eventType as NoteHistoryEntry["eventType"],
    at: e.createdAt,
    actor: e.actorUserId ? (people.get(e.actorUserId) ?? unknownUserRef(e.actorUserId)) : null,
    previousBody: bodyOf(e.previousValue),
    newBody: bodyOf(e.newValue),
    editCount: editCountOf(e.metadata),
  }));
}
