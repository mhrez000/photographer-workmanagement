import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobNotes } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { NoteKind } from "@/lib/constants";
import { getMyWorkNotePreviews } from "./myWork";

const NOW = "2026-10-08T13:30:00.000Z";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(async () => fakeClock.reset());

async function note(jobId: string, kind: NoteKind, body: string, at: string, extra: { isPinned?: boolean; archivedAt?: string } = {}) {
  await db.insert(jobNotes).values({
    organisationId: ids.organisationId,
    jobId,
    kind,
    body,
    authorUserId: ids.users.photographer1,
    createdAt: at,
    updatedAt: at,
    isPinned: extra.isPinned ?? false,
    archivedAt: extra.archivedAt ?? null,
  });
}

describe("getMyWorkNotePreviews", () => {
  it("returns one preview per job: pinned first, then latest; skips archived", async () => {
    const a = (await insertJobFixture(db, ids, { name: "a", statusKey: "in_progress", editorId: ids.users.editor1 })).job;
    const b = (await insertJobFixture(db, ids, { name: "b", statusKey: "in_progress", editorId: ids.users.editor1 })).job;
    await note(a.id, "photographer", "older", "2026-10-01T00:00:00.000Z");
    await note(a.id, "client", "newer", "2026-10-05T00:00:00.000Z");
    await note(a.id, "photographer", "archived newest", "2026-10-07T00:00:00.000Z", { archivedAt: "2026-10-07T01:00:00.000Z" });
    await note(b.id, "client", "latest", "2026-10-06T00:00:00.000Z");
    await note(b.id, "photographer", "pinned", "2026-10-02T00:00:00.000Z", { isPinned: true });

    // The job's photographer reads every kind on their own jobs.
    const previews = await getMyWorkNotePreviews(db, await contextFor(db, ids.users.photographer1), [a.id, b.id]);
    expect(previews[a.id]).toMatchObject({ kind: "client", body: "newer", isPinned: false });
    expect(previews[b.id]).toMatchObject({ kind: "photographer", body: "pinned", isPinned: true });
    // Editors never preview client notes (private, docs/ROLES.md §2.4).
    const forEditor = await getMyWorkNotePreviews(db, await contextFor(db, ids.users.editor1), [a.id, b.id]);
    expect(forEditor[a.id]).toMatchObject({ kind: "photographer", body: "older" });
    expect(forEditor[b.id]).toMatchObject({ kind: "photographer", body: "pinned" });
  });

  it("internal notes: admins and the managing photographer only; never editors, ⚑all members on others' jobs or clients", async () => {
    const j = (await insertJobFixture(db, ids, { name: "j", statusKey: "in_progress", editorId: ids.users.editor1, photographerId: ids.users.photographer1 }))
      .job;
    await note(j.id, "photographer", "visible", "2026-10-01T00:00:00.000Z");
    await note(j.id, "internal", "secret", "2026-10-05T00:00:00.000Z");

    expect((await getMyWorkNotePreviews(db, await contextFor(db, ids.users.editor1), [j.id]))[j.id]?.body).toBe("visible");
    expect((await getMyWorkNotePreviews(db, await contextFor(db, ids.users.photographer1), [j.id]))[j.id]?.body).toBe("secret");
    expect((await getMyWorkNotePreviews(db, await contextFor(db, ids.users.lead), [j.id]))[j.id]?.body).toBe("visible");
    expect((await getMyWorkNotePreviews(db, await contextFor(db, ids.users.coAdmin), [j.id]))[j.id]?.body).toBe("secret");
    // jobs the viewer cannot see never preview at all
    expect(await getMyWorkNotePreviews(db, await contextFor(db, ids.users.photographer2), [j.id])).toEqual({});
    expect(await getMyWorkNotePreviews(db, await contextFor(db, ids.users.client), [j.id])).toEqual({});
  });

  it("returns an empty map for no ids", async () => {
    expect(await getMyWorkNotePreviews(db, await contextFor(db, ids.users.editor1), [])).toEqual({});
  });
});
