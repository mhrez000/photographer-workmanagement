import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { Job } from "@/lib/types";
import { recordEvent, type RecordEventInput } from "@/server/audit";
import { NotFoundError } from "@/server/errors";
import { withTx } from "@/server/services/_shared";
import { listActivity } from "./activity";
import { getJobActivity, getJobHistory } from "./jobHistory";

let db: TestDb;
let ids: SeedIds;
let jobA: Job;
let jobB: Job;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  jobA = (await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1, photographerId: ids.users.photographer1, name: "Smith St" }))
    .job;
  jobB = (
    await insertJobFixture(db, ids, {
      statusKey: "in_progress",
      editorId: ids.users.editor2,
      photographerId: ids.users.photographer2,
      createdByUserId: ids.users.photographer2,
    })
  ).job;
});
afterEach(async () => fakeClock.reset());

const ctxOf = async (key: keyof SeedIds["users"]) => await contextFor(db, ids.users[key]);

async function record(actor: keyof SeedIds["users"], input: RecordEventInput, minutes = 1): Promise<string> {
  fakeClock.advanceMinutes(minutes);
  const ctx = await ctxOf(actor);
  return await withTx((tx) => recordEvent(tx, ctx, input), { db });
}

async function seedEvents() {
  const internalNote = await record("manager", {
    entityType: "note",
    entityId: "note-1",
    jobId: jobA.id,
    eventType: "note.added",
    action: "created",
    newValue: { kind: "internal", body: "client pays late" },
  });
  const editorNote = await record("editor1", {
    entityType: "note",
    entityId: "note-2",
    jobId: jobA.id,
    eventType: "note.added",
    action: "created",
    newValue: { kind: "editor", body: "using the warm LUT" },
  });
  const userUpdated = await record("owner", {
    entityType: "user",
    entityId: ids.users.editor1,
    eventType: "user.updated",
    action: "updated",
    previousValue: { name: "Eve" },
    newValue: { name: "Eve Editor" },
  });
  const clientCreated = await record("photographer1", {
    entityType: "client",
    entityId: "client-x",
    eventType: "client.created",
    action: "created",
    newValue: { name: "Coastal Homes" },
  });
  const jobBEvent = await record("photographer2", {
    entityType: "job",
    entityId: jobB.id,
    jobId: jobB.id,
    eventType: "job.priority_changed",
    action: "updated",
    previousValue: { priority: "normal" },
    newValue: { priority: "urgent" },
  });
  return { internalNote, editorNote, userUpdated, clientCreated, jobBEvent };
}

const idsOf = async (key: keyof SeedIds["users"], input: Record<string, unknown> = {}) =>
  (await listActivity(db, await ctxOf(key), { limit: 200, ...input })).items.map((i) => i.id);

describe("listActivity scoping", () => {
  it("hides management events from photographers and editors", async () => {
    const e = await seedEvents();
    const owner = await idsOf("owner");
    expect(owner).toEqual(expect.arrayContaining([e.internalNote, e.editorNote, e.userUpdated, e.clientCreated, e.jobBEvent]));
    expect(await idsOf("manager")).toEqual(expect.arrayContaining([e.internalNote, e.userUpdated]));

    const p1 = await idsOf("photographer1");
    expect(p1).toContain(e.editorNote);
    expect(p1).toContain(e.clientCreated); // own non-job event
    expect(p1).not.toContain(e.internalNote);
    expect(p1).not.toContain(e.userUpdated);
    expect(p1).not.toContain(e.jobBEvent); // job not visible

    const e1 = await idsOf("editor1");
    expect(e1).toContain(e.editorNote);
    expect(e1).not.toContain(e.internalNote);
    expect(e1).not.toContain(e.userUpdated);
    expect(e1).not.toContain(e.clientCreated);
    expect(e1).not.toContain(e.jobBEvent);

    const items = (await listActivity(db, await ctxOf("editor1"), { limit: 200 })).items;
    expect(items.every((i) => i.visibility === "all")).toBe(true);
  });

  it("job History / Activity tabs drop management events for P/E and 404 for invisible jobs", async () => {
    const e = await seedEvents();
    const forEditor = (await getJobActivity(db, await ctxOf("editor1"), jobA.id)).items.map((i) => i.id);
    expect(forEditor).toContain(e.editorNote);
    expect(forEditor).not.toContain(e.internalNote);
    expect((await getJobActivity(db, await ctxOf("manager"), jobA.id)).items.map((i) => i.id)).toContain(e.internalNote);
    await expect(getJobActivity(db, await ctxOf("editor2"), jobA.id)).rejects.toThrow(NotFoundError);
    await expect(getJobHistory(db, await ctxOf("photographer2"), jobA.id)).rejects.toThrow(NotFoundError);
  });

  it("never returns another organisation's events", async () => {
    await seedEvents();
    const other = await seedMinimalOrg(db, { slug: "other" });
    await insertJobFixture(db, other, { statusKey: "in_progress" });
    const otherIds = (await listActivity(db, await contextFor(db, other.users.owner), { limit: 200 })).items;
    expect(otherIds).toHaveLength(1);
    expect(otherIds[0].job?.jobNumber).toBe("PJ-0001");
    const mine = (await listActivity(db, await ctxOf("owner"), { limit: 200 })).items;
    expect(mine.every((i) => i.job === null || [jobA.id, jobB.id].includes(i.job.id))).toBe(true);
  });
});

describe("listActivity filters and feed shape", () => {
  it("filters by user, job, event type and date; paginates by keyset cursor", async () => {
    const e = await seedEvents();
    expect(await idsOf("owner", { userId: ids.users.photographer1 })).toEqual([
      e.clientCreated,
      ...(await idsOf("owner", { userId: ids.users.photographer1, eventType: "job.created" })),
    ]);
    expect(await idsOf("owner", { jobId: jobB.id, eventType: ["job.priority_changed"] })).toEqual([e.jobBEvent]);
    expect(await idsOf("owner", { eventType: "note.added,user.updated" })).toEqual([e.userUpdated, e.editorNote, e.internalNote]);
    expect(await idsOf("owner", { from: "2026-10-08T00:02:00.000Z", to: "2026-10-08T00:04:00.000Z" })).toEqual([e.userUpdated, e.editorNote]);
    expect(await idsOf("owner", { from: "2026-10-09" })).toEqual([]);

    const all = await idsOf("owner");
    const p1 = await listActivity(db, await ctxOf("owner"), { limit: 3 });
    expect(p1.items.map((i) => i.id)).toEqual(all.slice(0, 3));
    const p2 = await listActivity(db, await ctxOf("owner"), { limit: 3, cursor: p1.nextCursor });
    expect(p2.items.map((i) => i.id)).toEqual(all.slice(3, 6));
    expect(all).toHaveLength(7); // 2 job.created fixtures + 5 seeded
    const p3 = await listActivity(db, await ctxOf("owner"), { limit: 3, cursor: p2.nextCursor });
    expect(p3.items.map((i) => i.id)).toEqual(all.slice(6));
    expect(p3.nextCursor).toBeNull();
  });

  it("returns actor refs, job refs, frozen summary and a feed sentence", async () => {
    const e = await seedEvents();
    const item = (await listActivity(db, await ctxOf("owner"), { eventType: "job.priority_changed" })).items[0];
    expect(item.id).toBe(e.jobBEvent);
    expect(item.actor).toMatchObject({ id: ids.users.photographer2, name: "Paul Photographer" });
    expect(item.isSystem).toBe(false);
    expect(item.job).toEqual({ id: jobB.id, jobNumber: jobB.jobNumber, name: jobB.name });
    expect(item.summary.length).toBeGreaterThan(0);
    expect(item.sentence).toContain("Paul Photographer");
    expect(item.sentence).toContain(jobB.jobNumber);
    expect(item.metadata).toMatchObject({ cause: "user" });
  });
});
