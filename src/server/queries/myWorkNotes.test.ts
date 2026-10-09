import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobNotes } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { NoteKind } from "@/lib/constants";
import { getMyWorkNotePreviews } from "./myWork";

const NOW = "2026-10-08T13:30:00.000Z";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set(NOW);
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

function note(jobId: string, kind: NoteKind, body: string, at: string, extra: { isPinned?: boolean; archivedAt?: string } = {}) {
  db.insert(jobNotes)
    .values({
      organisationId: ids.organisationId,
      jobId,
      kind,
      body,
      authorUserId: ids.users.photographer1,
      createdAt: at,
      updatedAt: at,
      isPinned: extra.isPinned ?? false,
      archivedAt: extra.archivedAt ?? null,
    })
    .run();
}

describe("getMyWorkNotePreviews", () => {
  it("returns one preview per job: pinned first, then latest; skips archived", () => {
    const a = insertJobFixture(db, ids, { name: "a", statusKey: "in_progress", editorId: ids.users.editor1 }).job;
    const b = insertJobFixture(db, ids, { name: "b", statusKey: "in_progress", editorId: ids.users.editor1 }).job;
    note(a.id, "photographer", "older", "2026-10-01T00:00:00.000Z");
    note(a.id, "client", "newer", "2026-10-05T00:00:00.000Z");
    note(a.id, "photographer", "archived newest", "2026-10-07T00:00:00.000Z", { archivedAt: "2026-10-07T01:00:00.000Z" });
    note(b.id, "client", "latest", "2026-10-06T00:00:00.000Z");
    note(b.id, "photographer", "pinned", "2026-10-02T00:00:00.000Z", { isPinned: true });

    const previews = getMyWorkNotePreviews(db, contextFor(db, ids.users.editor1), [a.id, b.id]);
    expect(previews[a.id]).toMatchObject({ kind: "client", body: "newer", isPinned: false });
    expect(previews[b.id]).toMatchObject({ kind: "photographer", body: "pinned", isPinned: true });
  });

  it("never previews internal notes to editors or photographers; managers see them", () => {
    const j = insertJobFixture(db, ids, { name: "j", statusKey: "in_progress", editorId: ids.users.editor1, photographerId: ids.users.photographer1 }).job;
    note(j.id, "photographer", "visible", "2026-10-01T00:00:00.000Z");
    note(j.id, "internal", "secret", "2026-10-05T00:00:00.000Z");

    expect(getMyWorkNotePreviews(db, contextFor(db, ids.users.editor1), [j.id])[j.id]?.body).toBe("visible");
    expect(getMyWorkNotePreviews(db, contextFor(db, ids.users.photographer1), [j.id])[j.id]?.body).toBe("visible");
    expect(getMyWorkNotePreviews(db, contextFor(db, ids.users.manager), [j.id])[j.id]?.body).toBe("secret");
  });

  it("returns an empty map for no ids", () => {
    expect(getMyWorkNotePreviews(db, contextFor(db, ids.users.editor1), [])).toEqual({});
  });
});
