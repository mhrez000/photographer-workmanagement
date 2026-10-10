import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, setUserFlags, type SeedIds, type TestDb } from "@/db/test-db";
import type { Job } from "@/lib/types";
import { recordEvent, type RecordEventInput } from "@/server/audit";
import { NotFoundError } from "@/server/errors";
import { withTx } from "@/server/services/_shared";
import { jobEvents, listActivity } from "./activity";
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
  const internalNote = await record("coAdmin", {
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
    expect(await idsOf("coAdmin")).toEqual(expect.arrayContaining([e.internalNote, e.userUpdated]));

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
    expect((await getJobActivity(db, await ctxOf("coAdmin"), jobA.id)).items.map((i) => i.id)).toContain(e.internalNote);
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

describe("listActivity roles v2", () => {
  it("scope mine keeps only events of my shoots (+ own non-job events); ignored for non-holders", async () => {
    const e = await seedEvents();
    const ownShoot = (await insertJobFixture(db, ids, { statusKey: "new", photographerId: ids.users.owner, createdByUserId: ids.users.owner })).job;
    const ownEvent = await record("owner", {
      entityType: "job",
      entityId: ownShoot.id,
      jobId: ownShoot.id,
      eventType: "job.priority_changed",
      action: "updated",
      previousValue: { priority: "normal" },
      newValue: { priority: "high" },
    });
    const mine = await idsOf("owner", { scope: "mine" });
    expect(mine).toContain(ownEvent);
    expect(mine).not.toContain(e.jobBEvent);
    expect(mine).not.toContain(e.editorNote);
    expect(mine).toContain(e.userUpdated); // the owner's own non-job event
    // The cookie applies when no param is given; the param wins over it.
    const owner = await ctxOf("owner");
    const viaCookie = (await listActivity(db, owner, { limit: 200 }, { scopeCookie: "mine" })).items.map((i) => i.id);
    expect(viaCookie).toEqual(mine);
    const paramWins = (await listActivity(db, owner, { limit: 200, scope: "business" }, { scopeCookie: "mine" })).items.map((i) => i.id);
    expect(paramWins).toContain(e.jobBEvent);
    // Members without "See all jobs" and editors: ?scope is ignored, never an error or a widening.
    expect(await idsOf("photographer1", { scope: "mine" })).toEqual(await idsOf("photographer1"));
    expect(await idsOf("editor1", { scope: "business" })).toEqual(await idsOf("editor1"));
  });

  it("clients never read the staff feed (403) and never see their own events through it", async () => {
    await seedEvents();
    await expect(listActivity(db, await ctxOf("client"), {})).rejects.toThrow(/permission|staff/i);
    await expect(getJobActivity(db, await ctxOf("client"), jobA.id)).rejects.toThrow();
    await expect(getJobHistory(db, await ctxOf("client"), jobA.id)).rejects.toThrow(NotFoundError);
  });

  it("an editor's past access ends at their read cut-off (own events kept)", async () => {
    // editor2 held jobA before editor1: build a past assignment by reattribution.
    const { reattribute } = await import("./test-history");
    const before = await record("editor1", {
      entityType: "note",
      entityId: "n-before",
      jobId: jobA.id,
      eventType: "note.added",
      action: "created",
      newValue: { kind: "editor", body: "before handover" },
    });
    fakeClock.advanceMinutes(1);
    await reattribute(db, ids, jobA.id, ids.users.editor2, fakeClock.now());
    const after = await record("editor2", {
      entityType: "note",
      entityId: "n-after",
      jobId: jobA.id,
      eventType: "note.added",
      action: "created",
      newValue: { kind: "editor", body: "after handover" },
    });
    const forPast = await idsOf("editor1", { jobId: jobA.id });
    expect(forPast).toContain(before);
    expect(forPast).not.toContain(after);
    expect(await idsOf("editor2", { jobId: jobA.id })).toEqual(expect.arrayContaining([before, after]));
  });

  it("assignment reasons are hidden from editors who are neither the actor nor the subject", async () => {
    const ev = await record("owner", {
      entityType: "assignment",
      entityId: "asg-1",
      jobId: jobA.id,
      eventType: "assignment.created",
      action: "assigned",
      newValue: { userId: ids.users.photographer1, role: "photographer" },
      metadata: { reason: "client asked for Pia" },
    });
    const editorItem = (await listActivity(db, await ctxOf("editor1"), { limit: 200 })).items.find((i) => i.id === ev);
    expect(editorItem?.metadata.reason).toBeNull();
    const ownerItem = (await listActivity(db, await ctxOf("owner"), { limit: 200 })).items.find((i) => i.id === ev);
    expect(ownerItem?.metadata.reason).toBe("client asked for Pia");
  });
});

describe("listActivity privacy (editor overreach regressions)", () => {
  async function clientNoteEvents(): Promise<string[]> {
    const added = await record("photographer1", {
      entityType: "note",
      entityId: "note-client",
      jobId: jobA.id,
      eventType: "note.added",
      action: "created",
      newValue: { kind: "client", body: "Brand guidelines: keep whites neutral" },
    });
    const edited = await record("photographer1", {
      entityType: "note",
      entityId: "note-client",
      jobId: jobA.id,
      eventType: "note.edited",
      action: "updated",
      previousValue: { kind: "client", body: "Brand guidelines: keep whites neutral" },
      newValue: { kind: "client", body: "Brand guidelines: neutral whites, no warm cast" },
    });
    const archived = await record("photographer1", {
      entityType: "note",
      entityId: "note-client",
      jobId: jobA.id,
      eventType: "note.archived",
      action: "archived",
      previousValue: { kind: "client", body: "Brand guidelines: neutral whites, no warm cast", archivedAt: null },
      newValue: { kind: "client", body: "Brand guidelines: neutral whites, no warm cast", archivedAt: fakeClock.now() },
    });
    const restored = await record("photographer1", {
      entityType: "note",
      entityId: "note-client",
      jobId: jobA.id,
      eventType: "note.restored",
      action: "restored",
      previousValue: { kind: "client", archivedAt: fakeClock.now() },
      newValue: { kind: "client", body: "Brand guidelines: neutral whites, no warm cast", archivedAt: null },
    });
    return [added, edited, archived, restored];
  }

  it("editors never receive client-note events (job activity, global feed, history), even with see-other-editors' jobs", async () => {
    const clientEvents = await clientNoteEvents();
    const e = await seedEvents();
    await setUserFlags(db, ids.users.editor2, { canViewTeamJobs: true });

    for (const key of ["editor1", "editor2"] as const) {
      const ctx = await ctxOf(key);
      const global = (await listActivity(db, ctx, { limit: 200 })).items;
      const onJob = (await getJobActivity(db, ctx, jobA.id, { limit: 200 })).items;
      const filtered = (await listActivity(db, ctx, { limit: 200, eventType: ["note.added", "note.edited", "note.archived", "note.restored"] })).items;
      const history = await jobEvents(db, ctx, jobA.id);
      for (const items of [global, onJob, filtered, history]) {
        const got = items.map((i) => i.id);
        for (const id of clientEvents) expect(got).not.toContain(id);
        expect(JSON.stringify(items)).not.toContain("Brand guidelines");
      }
      // Notes they may read still flow (the team-view editor sees editor1's own note on jobA).
      expect(onJob.map((i) => i.id)).toContain(e.editorNote);
    }

    // Members on a visible job and admins keep them (note.read: client notes on visible jobs).
    expect(await idsOf("photographer1", { jobId: jobA.id })).toEqual(expect.arrayContaining(clientEvents));
    expect(await idsOf("lead", { jobId: jobA.id })).toEqual(expect.arrayContaining(clientEvents));
    expect(await idsOf("owner", { jobId: jobA.id })).toEqual(expect.arrayContaining(clientEvents));
  });

  it("editors with see-other-editors' jobs never get another person's work sessions; members only on managed jobs", async () => {
    await setUserFlags(db, ids.users.editor2, { canViewTeamJobs: true });
    const started = await record("editor1", {
      entityType: "work_session",
      entityId: "ws-1",
      jobId: jobA.id,
      eventType: "work_session.started",
      action: "started",
      newValue: { sessionId: "ws-1" },
      metadata: { sessionId: "ws-1" },
    });
    const ended = await record("editor1", {
      entityType: "work_session",
      entityId: "ws-1",
      jobId: jobA.id,
      eventType: "work_session.ended",
      action: "stopped",
      previousValue: { startedAt: "2026-10-08T00:01:00.000Z" },
      newValue: { endedAt: "2026-10-08T02:09:00.000Z", durationSeconds: 7728, endReason: "stopped" },
      metadata: { sessionId: "ws-1", sessionUserId: ids.users.editor1 },
    });
    // An admin stops editor1's timer: the session is still editor1's.
    const stoppedForMe = await record("owner", {
      entityType: "work_session",
      entityId: "ws-2",
      jobId: jobA.id,
      eventType: "work_session.ended",
      action: "stopped",
      previousValue: { startedAt: "2026-10-08T02:10:00.000Z" },
      newValue: { endedAt: "2026-10-08T02:30:00.000Z", durationSeconds: 1200, endReason: "stopped" },
      metadata: { sessionId: "ws-2", sessionUserId: ids.users.editor1, onBehalfOf: ids.users.editor1 },
    });
    const priority = await record("photographer1", {
      entityType: "job",
      entityId: jobA.id,
      jobId: jobA.id,
      eventType: "job.priority_changed",
      action: "updated",
      previousValue: { priority: "normal" },
      newValue: { priority: "high" },
    });
    const sessions = [started, ended, stoppedForMe];

    // editor2 (team view) reads jobA, but none of editor1's sessions — job tab, global feed or type filter.
    const e2 = await ctxOf("editor2");
    const onJob = (await getJobActivity(db, e2, jobA.id, { limit: 200 })).items.map((i) => i.id);
    expect(onJob).toContain(priority);
    for (const id of sessions) expect(onJob).not.toContain(id);
    const typed = (await listActivity(db, e2, { limit: 200, eventType: ["work_session.started", "work_session.ended"] })).items;
    expect(typed).toEqual([]);
    for (const id of sessions) expect(await idsOf("editor2")).not.toContain(id);

    // editor1 keeps their own sessions, including the one an admin stopped.
    expect(await idsOf("editor1", { jobId: jobA.id })).toEqual(expect.arrayContaining(sessions));
    // photographer1 manages jobA (timer.view_others), admins see all.
    expect(await idsOf("photographer1", { jobId: jobA.id })).toEqual(expect.arrayContaining(sessions));
    expect(await idsOf("owner", { jobId: jobA.id })).toEqual(expect.arrayContaining(sessions));
    // lead sees every job (⚑all) but manages none of jobA: job events yes, other people's timers no.
    const lead = await idsOf("lead", { jobId: jobA.id });
    expect(lead).toContain(priority);
    for (const id of sessions) expect(lead).not.toContain(id);
  });
});
