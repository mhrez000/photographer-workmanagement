import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clients, jobComments, jobNotes, projects } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { newId } from "@/lib/ids";
import { globalSearch } from "./search";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: keyof SeedIds["users"]) => contextFor(db, ids.users[key]);
const job = (opts: JobFixtureOptions) => insertJobFixture(db, ids, opts).job;

describe("globalSearch", () => {
  it("ranks an exact job number first and exposes it as exactJob", () => {
    const decoys = Array.from({ length: 12 }, (_, i) => job({ name: `Decoy ${i}` }));
    const target = decoys[2]; // PJ-0003
    job({ name: `Mentions ${target.jobNumber} in the name` });
    const res = globalSearch(db, ctxOf("owner"), target.jobNumber.toLowerCase());
    expect(res.exactJob?.id).toBe(target.id);
    expect(res.jobs[0]).toMatchObject({ id: target.id, matchedIn: "number" });
    expect(res.jobs.map((j) => j.id)).toContain(target.id);

    const bare = globalSearch(db, ctxOf("owner"), "3");
    expect(bare.exactJob?.jobNumber).toBe("PJ-0003");
    expect(bare.jobs[0].jobNumber).toBe("PJ-0003");
    expect(globalSearch(db, ctxOf("owner"), "Decoy").exactJob).toBeNull();
  });

  it("matches names, descriptions, notes and comments, scoped to visible jobs", () => {
    const own = job({ name: "Harbour twilight", description: "drone over the marina", photographerId: ids.users.photographer1 });
    const notMine = job({ name: "Harbour wedding", photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2, editorId: null });
    db.insert(jobNotes).values({ organisationId: ids.organisationId, jobId: notMine.id, kind: "photographer", body: "bring the gimbal", authorUserId: ids.users.photographer2 }).run();
    const cid = newId();
    db.insert(jobComments)
      .values({ id: cid, organisationId: ids.organisationId, jobId: own.id, rootCommentId: cid, authorUserId: ids.users.photographer1, body: "Sky replacement please" })
      .run();

    const p1 = globalSearch(db, ctxOf("photographer1"), "harbour");
    expect(p1.jobs.map((j) => j.id)).toEqual([own.id]);
    expect(p1.jobs[0].matchedIn).toBe("name");
    expect(globalSearch(db, ctxOf("photographer1"), "marina").jobs[0]).toMatchObject({ id: own.id, matchedIn: "description" });
    expect(globalSearch(db, ctxOf("photographer1"), "sky replacement").jobs[0]).toMatchObject({ id: own.id, matchedIn: "comment" });
    expect(globalSearch(db, ctxOf("photographer1"), "gimbal").jobs).toEqual([]);
    expect(globalSearch(db, ctxOf("photographer2"), "gimbal").jobs[0]).toMatchObject({ id: notMine.id, matchedIn: "note" });
    expect(globalSearch(db, ctxOf("owner"), "harbour").jobs).toHaveLength(2);
  });

  it("never matches internal notes for photographers / editors, archived notes or deleted comments", () => {
    const j = job({ statusKey: "in_progress", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });
    db.insert(jobNotes).values({ organisationId: ids.organisationId, jobId: j.id, kind: "internal", body: "client pays late", authorUserId: ids.users.manager }).run();
    db.insert(jobNotes)
      .values({ organisationId: ids.organisationId, jobId: j.id, kind: "editor", body: "old lut", authorUserId: ids.users.editor1, archivedAt: "2026-10-07T00:00:00.000Z" })
      .run();
    const cid = newId();
    db.insert(jobComments)
      .values({ id: cid, organisationId: ids.organisationId, jobId: j.id, rootCommentId: cid, authorUserId: ids.users.editor1, body: "removed words", deletedAt: "2026-10-07T00:00:00.000Z" })
      .run();
    expect(globalSearch(db, ctxOf("manager"), "pays late").jobs).toHaveLength(1);
    expect(globalSearch(db, ctxOf("editor1"), "pays late").jobs).toHaveLength(0);
    expect(globalSearch(db, ctxOf("photographer1"), "pays late").jobs).toHaveLength(0);
    expect(globalSearch(db, ctxOf("manager"), "old lut").jobs).toHaveLength(0);
    expect(globalSearch(db, ctxOf("manager"), "removed words").jobs).toHaveLength(0);
  });

  it("never returns another organisation's jobs, clients, projects or people", () => {
    const other = seedMinimalOrg(db, { slug: "other" });
    insertJobFixture(db, other, { name: "Harbour secret" });
    const res = globalSearch(db, ctxOf("owner"), "harbour");
    expect(res.jobs).toHaveLength(0);
    expect(res.clients.map((c) => c.id)).toEqual([ids.clientId]); // "Harbour Realty" of this org only
    expect(globalSearch(db, ctxOf("owner"), "smith").projects.map((p) => p.id)).toEqual([ids.projectId]);
    expect(globalSearch(db, ctxOf("owner"), "Eve").users.map((u) => u.id)).toEqual([ids.users.editor1]);
    expect(globalSearch(db, ctxOf("owner"), "PJ-0001").exactJob).toBeNull();
  });

  it("editors only find clients / projects of jobs visible to them; inactive users are hidden", () => {
    const coastal = db.insert(clients).values({ organisationId: ids.organisationId, name: "Coastal Homes" }).returning().get();
    db.insert(projects).values({ organisationId: ids.organisationId, clientId: coastal.id, name: "Coastal villa" }).run();
    job({ statusKey: "in_progress", editorId: ids.users.editor1 }); // on Harbour Realty / 123 Smith Street
    expect(globalSearch(db, ctxOf("editor1"), "coastal").clients).toEqual([]);
    expect(globalSearch(db, ctxOf("editor1"), "coastal").projects).toEqual([]);
    expect(globalSearch(db, ctxOf("editor1"), "harbour").clients.map((c) => c.id)).toEqual([ids.clientId]);
    expect(globalSearch(db, ctxOf("editor1"), "smith").projects.map((p) => p.client.name)).toEqual(["Harbour Realty"]);
    expect(globalSearch(db, ctxOf("photographer1"), "coastal").clients.map((c) => c.name)).toEqual(["Coastal Homes"]);
    expect(globalSearch(db, ctxOf("owner"), "Iris").users).toEqual([]);
    // Emails are searchable only for management.
    expect(globalSearch(db, ctxOf("owner"), "editor01@").users).toHaveLength(1);
    expect(globalSearch(db, ctxOf("editor1"), "editor01@").users).toHaveLength(0);
  });

  it("returns empty results for a blank query", () => {
    expect(globalSearch(db, ctxOf("owner"), "   ")).toEqual({ query: "", jobs: [], clients: [], projects: [], users: [], exactJob: null });
  });
});
