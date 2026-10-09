import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { organisationSettings, workSessions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { endOfCivilDayIso } from "@/lib/dates";
import type { MyWorkQueue } from "@/lib/types";
import { getMyWorkQueue } from "./myWork";

// 13:30 UTC on 8 Oct = 00:30 on Fri 9 Oct in Sydney (AEDT, +11).
const NOW = "2026-10-08T13:30:00.000Z";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set(NOW);
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const sydney = (civil: string) => endOfCivilDayIso(civil, "Australia/Sydney");
const job = (opts: JobFixtureOptions) => insertJobFixture(db, ids, { editorId: ids.users.editor1, ...opts }).job;

function sections(q: MyWorkQueue): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of ["overdue", "dueToday", "dueTomorrow", "upcoming", "waitingForReview", "revisionRequired", "paused"] as const) {
    out[key] = q[key].map((r) => r.name).sort();
  }
  return out;
}

describe("getMyWorkQueue", () => {
  it("buckets an editor's jobs by the organisation's civil day (Sydney)", () => {
    job({ name: "overdue", statusKey: "in_progress", dueDate: sydney("2026-10-08") });
    job({ name: "today", statusKey: "in_progress", dueDate: sydney("2026-10-09") });
    job({ name: "tomorrow", statusKey: "accepted", dueDate: sydney("2026-10-10") });
    job({ name: "later", statusKey: "assigned", dueDate: sydney("2026-10-14") });
    job({ name: "no-due", statusKey: "in_progress", dueDate: null });
    job({ name: "review", statusKey: "submitted", dueDate: sydney("2026-10-12") });
    job({ name: "revision", statusKey: "revision", dueDate: sydney("2026-10-12") });
    job({ name: "revision-overdue", statusKey: "revision", dueDate: sydney("2026-10-01") });
    job({ name: "paused", statusKey: "in_progress", isPaused: true, dueDate: sydney("2026-10-09") });
    job({ name: "approved", statusKey: "approved" });
    job({ name: "completed", statusKey: "completed" });
    job({ name: "someone-else", statusKey: "in_progress", editorId: ids.users.editor2 });

    const q = getMyWorkQueue(db, contextFor(db, ids.users.editor1));
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

  it("uses the organisation timezone, not UTC or the server clock", () => {
    db.update(organisationSettings).set({ timezone: "UTC" }).where(eq(organisationSettings.organisationId, ids.organisationId)).run();
    const utc = (civil: string) => endOfCivilDayIso(civil, "UTC");
    job({ name: "today-utc", statusKey: "in_progress", dueDate: utc("2026-10-08") });
    job({ name: "tomorrow-utc", statusKey: "in_progress", dueDate: utc("2026-10-09") });
    const q = getMyWorkQueue(db, contextFor(db, ids.users.editor1));
    expect(q.dueToday.map((r) => r.name)).toEqual(["today-utc"]);
    expect(q.dueTomorrow.map((r) => r.name)).toEqual(["tomorrow-utc"]);
  });

  it("photographers get their own active jobs (incl. approved), never others'", () => {
    job({ name: "mine-approved", statusKey: "approved", photographerId: ids.users.photographer1 });
    job({ name: "mine-review", statusKey: "review", photographerId: ids.users.photographer1 });
    job({ name: "created-by-me", statusKey: "new", editorId: null, photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer1 });
    job({ name: "theirs", statusKey: "in_progress", photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 });
    job({ name: "mine-done", statusKey: "completed", photographerId: ids.users.photographer1 });
    const q = getMyWorkQueue(db, contextFor(db, ids.users.photographer1));
    const all = Object.values(sections(q)).flat().sort();
    expect(all).toEqual(["created-by-me", "mine-approved", "mine-review"]);
    expect(q.waitingForReview.map((r) => r.name)).toEqual(["mine-review"]);
  });

  it("returns the actor's running timer", () => {
    const fx = insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    db.insert(workSessions)
      .values({
        organisationId: ids.organisationId,
        jobId: fx.job.id,
        userId: ids.users.editor1,
        statusIdAtStart: ids.statuses.in_progress,
        categoryAtStart: "in_progress",
        transitionId: fx.transitionId,
        startedAt: NOW,
      })
      .run();
    fakeClock.advanceMinutes(10);
    const q = getMyWorkQueue(db, contextFor(db, ids.users.editor1));
    expect(q.runningSession).toMatchObject({ isRunning: true, durationSeconds: 600, user: { id: ids.users.editor1 } });
    expect(getMyWorkQueue(db, contextFor(db, ids.users.editor2)).runningSession).toBeNull();
  });
});
