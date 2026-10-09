import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents } from "@/db/schema";
import {
  contextFor,
  fakeClock,
  insertJobFixture,
  makeTestDb,
  seedMinimalOrg,
  systemContextFor,
  type SeedIds,
  type TestDb,
} from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { addNote, archiveNote, editNote, listNotes, noteHistory, restoreNote } from "./notes";

let db: TestDb;
let ids: SeedIds;
let jobId: string;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
  jobId = insertJobFixture(db, ids, { statusKey: "in_progress" }).job.id;
});
afterEach(() => fakeClock.reset());

function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => T): T {
  const ctx = contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

function noteEvents(noteId: string) {
  return db.select().from(activityEvents).where(eq(activityEvents.entityId, noteId)).all();
}

describe("addNote permissions per kind", () => {
  it("photographer: own job, photographer/client/revision kinds only", () => {
    const note = run(ids.users.photographer1, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "photographer", body: "Shoot was overcast" }));
    expect(note).toMatchObject({ kind: "photographer", authorUserId: ids.users.photographer1, editCount: 0, version: 1 });
    expect(() => run(ids.users.photographer1, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "internal", body: "x" }))).toThrow(
      ForbiddenError,
    );
    expect(() => run(ids.users.photographer1, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "editor", body: "x" }))).toThrow(
      ForbiddenError,
    );
    // photographer2 does not own (or see) the job → 404, no existence oracle.
    expect(() => run(ids.users.photographer2, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "client", body: "x" }))).toThrow(
      NotFoundError,
    );
  });

  it("editor: assigned job, editor/revision kinds only", () => {
    run(ids.users.editor1, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "editor", body: "Used preset B" }));
    expect(() => run(ids.users.editor1, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "client", body: "x" }))).toThrow(ForbiddenError);
    expect(() => run(ids.users.editor2, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "editor", body: "x" }))).toThrow(NotFoundError); // invisible job
  });

  it("writes note.added; internal notes produce management-only events", () => {
    const pub = run(ids.users.manager, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "client", body: "Agent prefers warm tones" }));
    const internal = run(ids.users.manager, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "internal", body: "Client pays late" }));
    expect(noteEvents(pub.id)[0]).toMatchObject({ eventType: "note.added", visibility: "all", jobId });
    expect(noteEvents(internal.id)[0]).toMatchObject({ eventType: "note.added", visibility: "management" });
  });

  it("rejects a revision id on non-revision notes and unknown jobs", () => {
    expect(() => run(ids.users.manager, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "client", body: "x", revisionId: "r1" }))).toThrow(
      ValidationError,
    );
    expect(() => run(ids.users.manager, (tx, ctx) => addNote(tx, ctx, { jobId: "missing", kind: "client", body: "x" }))).toThrow(
      NotFoundError,
    );
  });

  it("system context (automation add_note) records the job creator as author", () => {
    const ctx = systemContextFor(db, ids.organisationId);
    const note = withTx((tx) => addNote(tx, ctx, { jobId, kind: "revision", body: "Auto note" }), { db });
    expect(note.authorUserId).toBe(ids.users.photographer1);
    expect(noteEvents(note.id)[0].actorUserId).toBeNull();
  });
});

describe("editNote + history", () => {
  it("keeps every prior body in note.edited events and bumps edit_count", () => {
    const note = run(ids.users.photographer1, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "photographer", body: "v1" }));
    fakeClock.advanceMinutes(5);
    const v2 = run(ids.users.photographer1, (tx, ctx) => editNote(tx, ctx, { noteId: note.id, expectedVersion: 1, body: "v2" }));
    expect(v2).toMatchObject({ body: "v2", editCount: 1, version: 2, lastEditedByUserId: ids.users.photographer1 });
    fakeClock.advanceMinutes(5);
    const v3 = run(ids.users.manager, (tx, ctx) => editNote(tx, ctx, { noteId: note.id, expectedVersion: 2, body: "v3" }));
    expect(v3).toMatchObject({ body: "v3", editCount: 2, version: 3, lastEditedByUserId: ids.users.manager });

    const history = noteHistory(db, contextFor(db, ids.users.editor1), note.id);
    expect(history.map((h) => h.eventType)).toEqual(["note.added", "note.edited", "note.edited"]);
    expect(history.map((h) => [h.previousBody, h.newBody])).toEqual([
      [null, "v1"],
      ["v1", "v2"],
      ["v2", "v3"],
    ]);
    expect(history[2].actor?.id).toBe(ids.users.manager);
    expect(history[2].editCount).toBe(2);
  });

  it("409 on a stale version; pin-only changes do not count as body edits", () => {
    const note = run(ids.users.manager, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "client", body: "a" }));
    expect(() => run(ids.users.manager, (tx, ctx) => editNote(tx, ctx, { noteId: note.id, expectedVersion: 7, body: "b" }))).toThrow(
      ConflictError,
    );
    const pinned = run(ids.users.manager, (tx, ctx) => editNote(tx, ctx, { noteId: note.id, expectedVersion: 1, isPinned: true }));
    expect(pinned).toMatchObject({ isPinned: true, editCount: 0, version: 2 });
    expect(noteEvents(note.id).map((e) => e.eventType)).toEqual(["note.added", "note.edited"]);
  });

  it("editors may only edit their own notes", () => {
    const other = run(ids.users.manager, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "editor", body: "by manager" }));
    expect(() => run(ids.users.editor1, (tx, ctx) => editNote(tx, ctx, { noteId: other.id, expectedVersion: 1, body: "x" }))).toThrow(
      ForbiddenError,
    );
    const own = run(ids.users.editor1, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "editor", body: "mine" }));
    expect(run(ids.users.editor1, (tx, ctx) => editNote(tx, ctx, { noteId: own.id, expectedVersion: 1, body: "mine 2" })).body).toBe(
      "mine 2",
    );
  });

  it("editors cannot read internal note history", () => {
    const internal = run(ids.users.owner, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "internal", body: "secret-ish" }));
    expect(() => noteHistory(db, contextFor(db, ids.users.editor1), internal.id)).toThrow(ForbiddenError);
  });
});

describe("archive / restore / list", () => {
  it("archives and restores with events; list hides archived and internal notes per role", () => {
    const client = run(ids.users.photographer1, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "client", body: "c" }));
    run(ids.users.owner, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "internal", body: "i" }));

    expect(listNotes(db, contextFor(db, ids.users.editor1), jobId).map((n) => n.kind)).toEqual(["client"]);
    expect(listNotes(db, contextFor(db, ids.users.owner), jobId).map((n) => n.kind).sort()).toEqual(["client", "internal"]);
    // photographer sees internal notes on own jobs only (§3.2)
    expect(listNotes(db, contextFor(db, ids.users.photographer1), jobId)).toHaveLength(2);

    const archived = run(ids.users.photographer1, (tx, ctx) => archiveNote(tx, ctx, { noteId: client.id }));
    expect(archived.archivedAt).toBe(fakeClock.now());
    expect(listNotes(db, contextFor(db, ids.users.editor1), jobId)).toHaveLength(0);
    expect(listNotes(db, contextFor(db, ids.users.editor1), jobId, { includeArchived: true })).toHaveLength(1);
    expect(() =>
      run(ids.users.photographer1, (tx, ctx) => editNote(tx, ctx, { noteId: client.id, expectedVersion: archived.version, body: "z" })),
    ).toThrow(ValidationError);

    const restored = run(ids.users.photographer1, (tx, ctx) => restoreNote(tx, ctx, { noteId: client.id }));
    expect(restored.archivedAt).toBeNull();
    expect(noteEvents(client.id).map((e) => e.eventType)).toEqual(["note.added", "note.archived", "note.restored"]);
  });
});
