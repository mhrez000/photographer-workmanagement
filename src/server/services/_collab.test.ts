import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { withTx } from "./_shared";
import { loadJobWithRef } from "./_collab";
import { addComment, listComments } from "./comments";
import { listLinks } from "./links";
import { addNote, listNotes } from "./notes";
import { listSessions } from "./timeTracking";

let db: TestDb;
let ids: SeedIds;
let hiddenJobId: string;
let ownJobId: string;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
  // editor2's job: editor1 was never on it and has no team flag → invisible to editor1
  hiddenJobId = insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor2 }).job.id;
  ownJobId = insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 }).job.id;
});
afterEach(() => fakeClock.reset());

describe("collaboration loaders: no existence oracle", () => {
  it("an in-org job the actor cannot see is a 404, exactly like a nonexistent id", () => {
    const editor1 = contextFor(db, ids.users.editor1);
    for (const jobId of [hiddenJobId, "does-not-exist"]) {
      expect(() => loadJobWithRef(db, editor1, jobId)).toThrow(NotFoundError);
      expect(() => listNotes(db, editor1, jobId)).toThrow(NotFoundError);
      expect(() => listComments(db, editor1, jobId)).toThrow(NotFoundError);
      expect(() => listLinks(db, editor1, jobId)).toThrow(NotFoundError);
      expect(() => listSessions(db, editor1, jobId)).toThrow(NotFoundError);
      expect(() => withTx((tx) => addComment(tx, editor1, { jobId, body: "hello" }), { db })).toThrow(NotFoundError);
    }
  });

  it("the job's own editor and management still load it", () => {
    expect(listNotes(db, contextFor(db, ids.users.editor2), hiddenJobId)).toEqual([]);
    expect(listComments(db, contextFor(db, ids.users.manager), hiddenJobId)).toEqual([]);
  });

  it("a VISIBLE job where the specific action is denied stays a 403", () => {
    const editor1 = contextFor(db, ids.users.editor1);
    expect(() => withTx((tx) => addNote(tx, editor1, { jobId: ownJobId, kind: "internal", body: "secret" }), { db })).toThrow(ForbiddenError);
  });
});
