import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { organisationSettings, workSessions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, inviteDefaultsMember, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { endOfCivilDayIso } from "@/lib/dates";
import type { MyWorkQueue } from "@/lib/types";
import { getMyWorkQueue } from "./myWork";

// 13:30 UTC on 8 Oct = 00:30 on Fri 9 Oct in Sydney (AEDT, +11).
const NOW = "2026-10-08T13:30:00.000Z";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(async () => fakeClock.reset());

const sydney = (civil: string) => endOfCivilDayIso(civil, "Australia/Sydney");
const job = async (opts: JobFixtureOptions) => (await insertJobFixture(db, ids, { editorId: ids.users.editor1, ...opts })).job;

function sections(q: MyWorkQueue): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of ["overdue", "dueToday", "dueTomorrow", "upcoming", "waitingForReview", "revisionRequired", "paused"] as const) {
    out[key] = q[key].map((r) => r.name).sort();
  }
  return out;
}

describe("getMyWorkQueue", () => {
  it("buckets an editor's jobs by the organisation's civil day (Sydney)", async () => {
    await job({ name: "overdue", statusKey: "in_progress", dueDate: sydney("2026-10-08") });
    await job({ name: "today", statusKey: "in_progress", dueDate: sydney("2026-10-09") });
    await job({ name: "tomorrow", statusKey: "accepted", dueDate: sydney("2026-10-10") });
    await job({ name: "later", statusKey: "assigned", dueDate: sydney("2026-10-14") });
    await job({ name: "no-due", statusKey: "in_progress", dueDate: null });
    await job({ name: "review", statusKey: "submitted", dueDate: sydney("2026-10-12") });
    await job({ name: "revision", statusKey: "revision", dueDate: sydney("2026-10-12") });
    await job({ name: "revision-overdue", statusKey: "revision", dueDate: sydney("2026-10-01") });
    await job({ name: "paused", statusKey: "in_progress", isPaused: true, dueDate: sydney("2026-10-09") });
    await job({ name: "approved", statusKey: "approved" });
    await job({ name: "completed", statusKey: "completed" });
    await job({ name: "someone-else", statusKey: "in_progress", editorId: ids.users.editor2 });

    const q = await getMyWorkQueue(db, await contextFor(db, ids.users.editor1));
    expect(sections(q)).toEqual({
      overdue: ["overdue", "revision-overdue"],
      dueToday: ["today"],
      dueTomorrow: ["tomorrow"],
      upcoming: ["later", "no-due"],
      waitingForReview: ["review"],
      revisionRequired: ["revision"],
      paused: ["paused"],
    });
    expect(q.runningSession).toBeNull();
    expect(q.dueToday[0]).toMatchObject({ isDueToday: true, daysRemaining: 0 });
    expect(q.overdue.find((r) => r.name === "overdue")).toMatchObject({ isOverdue: true, daysRemaining: -1 });
  });

  it("uses the organisation timezone, not UTC or the server clock", async () => {
    await db.update(organisationSettings).set({ timezone: "UTC" }).where(eq(organisationSettings.organisationId, ids.organisationId));
    const utc = (civil: string) => endOfCivilDayIso(civil, "UTC");
    await job({ name: "today-utc", statusKey: "in_progress", dueDate: utc("2026-10-08") });
    await job({ name: "tomorrow-utc", statusKey: "in_progress", dueDate: utc("2026-10-09") });
    const q = await getMyWorkQueue(db, await contextFor(db, ids.users.editor1));
    expect(q.dueToday.map((r) => r.name)).toEqual(["today-utc"]);
    expect(q.dueTomorrow.map((r) => r.name)).toEqual(["tomorrow-utc"]);
  });

  it("photographers get their own active jobs (incl. approved), never others'", async () => {
    await job({ name: "mine-approved", statusKey: "approved", photographerId: ids.users.photographer1 });
    await job({ name: "mine-review", statusKey: "review", photographerId: ids.users.photographer1 });
    await job({ name: "created-by-me", statusKey: "new", editorId: null, photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer1 });
    await job({ name: "theirs", statusKey: "in_progress", photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 });
    await job({ name: "mine-done", statusKey: "completed", photographerId: ids.users.photographer1 });
    const q = await getMyWorkQueue(db, await contextFor(db, ids.users.photographer1));
    const all = Object.values(sections(q)).flat().sort();
    expect(all).toEqual(["created-by-me", "mine-approved", "mine-review"]);
    expect(q.waitingForReview.map((r) => r.name)).toEqual(["mine-review"]);
  });

  it("returns the actor's running timer", async () => {
    const fx = await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    await db.insert(workSessions).values({
      organisationId: ids.organisationId,
      jobId: fx.job.id,
      userId: ids.users.editor1,
      statusIdAtStart: ids.statuses.in_progress,
      categoryAtStart: "in_progress",
      transitionId: fx.transitionId,
      startedAt: NOW,
    });
    fakeClock.advanceMinutes(10);
    const q = await getMyWorkQueue(db, await contextFor(db, ids.users.editor1));
    expect(q.runningSession).toMatchObject({ isRunning: true, durationSeconds: 600, user: { id: ids.users.editor1 } });
    expect((await getMyWorkQueue(db, await contextFor(db, ids.users.editor2))).runningSession).toBeNull();
  });
});

describe("getMyWorkQueue — roles v2", () => {
  it("admins get their shoots plus reviews only an admin can do; never other members' reviewable jobs", async () => {
    const junior = await inviteDefaultsMember(db, ids); // review ✗ → the owner reviews
    await job({ name: "own-shoot", statusKey: "in_progress", photographerId: ids.users.owner, createdByUserId: ids.users.owner });
    await job({ name: "junior-review", statusKey: "submitted", photographerId: junior, createdByUserId: junior });
    await job({ name: "p1-review", statusKey: "submitted", photographerId: ids.users.photographer1 }); // photographer1 reviews their own
    await job({ name: "for-p2", statusKey: "in_progress", photographerId: ids.users.photographer2, createdByUserId: ids.users.owner });
    const q = await getMyWorkQueue(db, await contextFor(db, ids.users.owner));
    expect(Object.values(sections(q)).flat().sort()).toEqual(["for-p2", "junior-review", "own-shoot"]);
    expect(q.waitingForReview.map((r) => r.name)).toEqual(["junior-review"]);
    // a co-admin's queue has the junior's review too, but not the owner's shoot
    const co = await getMyWorkQueue(db, await contextFor(db, ids.users.coAdmin));
    expect(Object.values(sections(co)).flat()).toEqual(["junior-review"]);
  });

  it("editors: jobs they hold only (not jobs they created for someone else to edit); clients: nothing", async () => {
    await job({ name: "held", statusKey: "in_progress" });
    await job({ name: "created-unassigned", statusKey: "new", editorId: null, createdByUserId: ids.users.editor1, photographerId: ids.users.owner });
    const q = await getMyWorkQueue(db, await contextFor(db, ids.users.editor1));
    expect(Object.values(sections(q)).flat()).toEqual(["held"]);
    const client = await getMyWorkQueue(db, await contextFor(db, ids.users.client));
    expect(Object.values(sections(client)).flat()).toEqual([]);
    expect(client.runningSession).toBeNull();
  });
});
