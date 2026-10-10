import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clients, jobComments, jobNotes, projects } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { newId } from "@/lib/ids";
import { globalSearch } from "./search";
import { reattribute } from "./test-history";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(async () => fakeClock.reset());

const ctxOf = async (key: keyof SeedIds["users"]) => await contextFor(db, ids.users[key]);
const job = async (opts: JobFixtureOptions) => (await insertJobFixture(db, ids, opts)).job;

describe("globalSearch", () => {
  it("matches the current workflow status name (case-insensitive), within visibility", async () => {
    const visible = await job({ statusKey: "revision", editorId: ids.users.editor1, name: "Bondi apartment" });
    const hidden = await job({ statusKey: "revision", editorId: ids.users.editor2, name: "Manly house" });
    await job({ statusKey: "in_progress", editorId: ids.users.editor1, name: "Coogee villa" });

    const owner = await globalSearch(db, await ctxOf("owner"), "Revision Required");
    expect(owner.jobs.map((j) => j.id).sort()).toEqual([visible.id, hidden.id].sort());
    expect(owner.jobs.every((j) => j.matchedIn === "status" && j.status.category === "revision")).toBe(true);
    expect((await globalSearch(db, await ctxOf("owner"), "revision required")).jobs).toHaveLength(2);

    const editor = await globalSearch(db, await ctxOf("editor1"), "Revision Required");
    expect(editor.jobs.map((j) => j.id)).toEqual([visible.id]);
    expect(editor.jobs.map((j) => j.id)).not.toContain(hidden.id);
  });

  it("ranks an exact job number first and exposes it as exactJob", async () => {
    const decoys = [];
    for (let i = 0; i < 12; i++) decoys.push(await job({ name: `Decoy ${i}` }));
    const target = decoys[2]; // PJ-0003
    await job({ name: `Mentions ${target.jobNumber} in the name` });
    const res = await globalSearch(db, await ctxOf("owner"), target.jobNumber.toLowerCase());
    expect(res.exactJob?.id).toBe(target.id);
    expect(res.jobs[0]).toMatchObject({ id: target.id, matchedIn: "number" });
    expect(res.jobs.map((j) => j.id)).toContain(target.id);

    const bare = await globalSearch(db, await ctxOf("owner"), "3");
    expect(bare.exactJob?.jobNumber).toBe("PJ-0003");
    expect(bare.jobs[0].jobNumber).toBe("PJ-0003");
    expect((await globalSearch(db, await ctxOf("owner"), "Decoy")).exactJob).toBeNull();
  });

  it("matches names, descriptions, notes and comments, scoped to visible jobs", async () => {
    const own = await job({ name: "Harbour twilight", description: "drone over the marina", photographerId: ids.users.photographer1 });
    const notMine = await job({ name: "Harbour wedding", photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2, editorId: null });
    await db
      .insert(jobNotes)
      .values({ organisationId: ids.organisationId, jobId: notMine.id, kind: "photographer", body: "bring the gimbal", authorUserId: ids.users.photographer2 });
    const cid = newId();
    await db
      .insert(jobComments)
      .values({
        id: cid,
        organisationId: ids.organisationId,
        jobId: own.id,
        rootCommentId: cid,
        authorUserId: ids.users.photographer1,
        body: "Sky replacement please",
      });

    const p1 = await globalSearch(db, await ctxOf("photographer1"), "harbour");
    expect(p1.jobs.map((j) => j.id)).toEqual([own.id]);
    expect(p1.jobs[0].matchedIn).toBe("name");
    expect((await globalSearch(db, await ctxOf("photographer1"), "marina")).jobs[0]).toMatchObject({ id: own.id, matchedIn: "description" });
    expect((await globalSearch(db, await ctxOf("photographer1"), "sky replacement")).jobs[0]).toMatchObject({ id: own.id, matchedIn: "comment" });
    expect((await globalSearch(db, await ctxOf("photographer1"), "gimbal")).jobs).toEqual([]);
    expect((await globalSearch(db, await ctxOf("photographer2"), "gimbal")).jobs[0]).toMatchObject({ id: notMine.id, matchedIn: "note" });
    expect((await globalSearch(db, await ctxOf("owner"), "harbour")).jobs).toHaveLength(2);
  });

  it("internal notes: admins any job, members only jobs they manage, editors never; archived notes / deleted comments never", async () => {
    const j = await job({ statusKey: "in_progress", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });
    await db
      .insert(jobNotes)
      .values({ organisationId: ids.organisationId, jobId: j.id, kind: "internal", body: "client pays late", authorUserId: ids.users.owner });
    await db
      .insert(jobNotes)
      .values({
        organisationId: ids.organisationId,
        jobId: j.id,
        kind: "editor",
        body: "old lut",
        authorUserId: ids.users.editor1,
        archivedAt: "2026-10-07T00:00:00.000Z",
      });
    const cid = newId();
    await db
      .insert(jobComments)
      .values({
        id: cid,
        organisationId: ids.organisationId,
        jobId: j.id,
        rootCommentId: cid,
        authorUserId: ids.users.editor1,
        body: "removed words",
        deletedAt: "2026-10-07T00:00:00.000Z",
      });
    expect((await globalSearch(db, await ctxOf("coAdmin"), "pays late")).jobs).toHaveLength(1);
    expect((await globalSearch(db, await ctxOf("editor1"), "pays late")).jobs).toHaveLength(0);
    expect((await globalSearch(db, await ctxOf("photographer1"), "pays late")).jobs).toHaveLength(1); // manages the job
    // a ⚑all member sees the job but gets no internal-note hit on someone else's job (no content oracle)
    expect((await globalSearch(db, await ctxOf("lead"), j.jobNumber)).jobs).toHaveLength(1);
    expect((await globalSearch(db, await ctxOf("lead"), "pays late")).jobs).toHaveLength(0);
    expect((await globalSearch(db, await ctxOf("coAdmin"), "old lut")).jobs).toHaveLength(0);
    expect((await globalSearch(db, await ctxOf("coAdmin"), "removed words")).jobs).toHaveLength(0);
    // client notes: never for editors
    await db.insert(jobNotes).values({ organisationId: ids.organisationId, jobId: j.id, kind: "client", body: "prefers email", authorUserId: ids.users.owner });
    expect((await globalSearch(db, await ctxOf("editor1"), "prefers email")).jobs).toHaveLength(0);
    expect((await globalSearch(db, await ctxOf("photographer1"), "prefers email")).jobs).toHaveLength(1);
  });

  it("never returns another organisation's jobs, clients, projects or people", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    await insertJobFixture(db, other, { name: "Harbour secret" });
    const res = await globalSearch(db, await ctxOf("owner"), "harbour");
    expect(res.jobs).toHaveLength(0);
    expect(res.clients.map((c) => c.id)).toEqual([ids.clientId]); // "Harbour Realty" of this org only
    expect((await globalSearch(db, await ctxOf("owner"), "smith")).projects.map((p) => p.id)).toEqual([ids.projectId]);
    expect((await globalSearch(db, await ctxOf("owner"), "Eve")).users.map((u) => u.id)).toEqual([ids.users.editor1]);
    expect((await globalSearch(db, await ctxOf("owner"), "PJ-0001")).exactJob).toBeNull();
  });

  it("editors only find clients / projects of jobs visible to them; inactive users are hidden", async () => {
    const coastal = (await db.insert(clients).values({ organisationId: ids.organisationId, name: "Coastal Homes" }).returning())[0];
    await db.insert(projects).values({ organisationId: ids.organisationId, clientId: coastal.id, name: "Coastal villa" });
    await job({ statusKey: "in_progress", editorId: ids.users.editor1 }); // on Harbour Realty / 123 Smith Street
    expect((await globalSearch(db, await ctxOf("editor1"), "coastal")).clients).toEqual([]);
    expect((await globalSearch(db, await ctxOf("editor1"), "coastal")).projects).toEqual([]);
    expect((await globalSearch(db, await ctxOf("editor1"), "harbour")).clients.map((c) => c.id)).toEqual([ids.clientId]);
    expect((await globalSearch(db, await ctxOf("editor1"), "smith")).projects.map((p) => p.client.name)).toEqual(["Harbour Realty"]);
    expect((await globalSearch(db, await ctxOf("photographer1"), "coastal")).clients.map((c) => c.name)).toEqual(["Coastal Homes", "Coastal Key Property"]);
    expect((await globalSearch(db, await ctxOf("owner"), "Iris")).users).toEqual([]);
    // Emails are searchable only for admins; editors get no people results at all (team.view_members).
    expect((await globalSearch(db, await ctxOf("owner"), "editor01@")).users).toHaveLength(1);
    expect((await globalSearch(db, await ctxOf("photographer1"), "editor01@")).users).toHaveLength(0);
    expect((await globalSearch(db, await ctxOf("editor1"), "Eve")).users).toHaveLength(0);
  });

  it("people search never returns client portal users to team members; admins find them", async () => {
    expect((await globalSearch(db, await ctxOf("photographer1"), "Cleo")).users).toEqual([]);
    expect((await globalSearch(db, await ctxOf("owner"), "Cleo")).users.map((u) => u.id)).toEqual([ids.users.client]);
  });

  it("clients (portal users) cannot search the studio (403)", async () => {
    await job({ name: "Harbour shared", sharedWithClient: true, statusKey: "delivered" });
    await expect(globalSearch(db, await ctxOf("client"), "harbour")).rejects.toThrow(/permission/);
  });

  it("an editor's past job only matches comments up to their cut-off (and their own)", async () => {
    const j = await job({ statusKey: "in_progress", editorId: ids.users.editor1 });
    await db.insert(jobComments).values({ organisationId: ids.organisationId, jobId: j.id, authorUserId: ids.users.photographer1, body: "early sunset note", createdAt: fakeClock.now() });
    fakeClock.advanceMinutes(5);
    await reattribute(db, ids, j.id, ids.users.editor2, fakeClock.now());
    fakeClock.advanceMinutes(5);
    await db.insert(jobComments).values({ organisationId: ids.organisationId, jobId: j.id, authorUserId: ids.users.photographer1, body: "late sunset note", createdAt: fakeClock.now() });
    expect((await globalSearch(db, await ctxOf("editor1"), "early sunset")).jobs).toHaveLength(1);
    expect((await globalSearch(db, await ctxOf("editor1"), "late sunset")).jobs).toHaveLength(0);
    expect((await globalSearch(db, await ctxOf("editor2"), "late sunset")).jobs).toHaveLength(1);
  });

  it("returns empty results for a blank query", async () => {
    expect(await globalSearch(db, await ctxOf("owner"), "   ")).toEqual({ query: "", jobs: [], clients: [], projects: [], users: [], exactJob: null });
  });
});
