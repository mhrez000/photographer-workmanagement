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

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
  // editor2's job: editor1 was never on it and has no team flag → invisible to editor1
  hiddenJobId = (await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor2 })).job.id;
  ownJobId = (await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 })).job.id;
});
afterEach(() => fakeClock.reset());

describe("collaboration loaders: no existence oracle", () => {
  it("an in-org job the actor cannot see is a 404, exactly like a nonexistent id", async () => {
    const editor1 = await contextFor(db, ids.users.editor1);
    for (const jobId of [hiddenJobId, "does-not-exist"]) {
      await expect(loadJobWithRef(db, editor1, jobId)).rejects.toThrow(NotFoundError);
      await expect(listNotes(db, editor1, jobId)).rejects.toThrow(NotFoundError);
      await expect(listComments(db, editor1, jobId)).rejects.toThrow(NotFoundError);
      await expect(listLinks(db, editor1, jobId)).rejects.toThrow(NotFoundError);
      await expect(listSessions(db, editor1, jobId)).rejects.toThrow(NotFoundError);
      await expect(withTx((tx) => addComment(tx, editor1, { jobId, body: "hello" }), { db })).rejects.toThrow(NotFoundError);
    }
  });

  it("the job's own editor and management still load it", async () => {
    expect(await listNotes(db, await contextFor(db, ids.users.editor2), hiddenJobId)).toEqual([]);
    expect(await listComments(db, await contextFor(db, ids.users.coAdmin), hiddenJobId)).toEqual([]);
  });

  it("a VISIBLE job where the specific action is denied stays a 403", async () => {
    const editor1 = await contextFor(db, ids.users.editor1);
    await expect(
      withTx((tx) => addNote(tx, editor1, { jobId: ownJobId, kind: "internal", body: "secret" }), { db }),
    ).rejects.toThrow(ForbiddenError);
  });
});
