import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, automationRuns, notifications, organisationSettings, workSessions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, systemContextFor, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import type { NotificationType } from "@/lib/constants";
import { AppError } from "@/server/errors";
import { withTx } from "./_shared";
import { createAutomation } from "./automations";
import { setDueDate } from "./jobs";
import { maybeRunSweep, runSweep } from "./sweep";
import { startTimer } from "./timeTracking";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z"); // 11:00 Sydney
  db = makeTestDb();
  ids = seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => T): T => withTx(fn, { db });
const sweep = () => runSweep(db, ctxOf("manager"));
const eventsOf = (type: string, jobId?: string) =>
  db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.eventType, type), jobId ? eq(activityEvents.jobId, jobId) : undefined))
    .orderBy(asc(activityEvents.createdAt))
    .all();
const noticesOf = (type: NotificationType) => db.select().from(notifications).where(eq(notifications.type, type)).all();

function expectClean() {
  const report = verifyDerived(db.$client);
  expect(report.drift).toEqual([]);
  expect(report.structural).toEqual([]);
}

describe("job.became_overdue", () => {
  it("emits once per (job, dueDate), notifies editor + photographer, fires job_overdue rules, re-arms after a deadline change", () => {
    const rule = run((tx) =>
      createAutomation(tx, ctxOf("manager"), { name: "Overdue → managers", trigger: { type: "job_overdue" }, actions: [{ type: "notify", target: "managers" }] }),
    );
    const late = insertJobFixture(db, ids, { statusKey: "in_progress", dueDate: "2026-10-07T12:59:59.999Z" }).job;
    const later = insertJobFixture(db, ids, { statusKey: "in_progress", dueDate: "2026-10-09T12:59:59.999Z" }).job; // not yet due
    insertJobFixture(db, ids, { statusKey: "approved", dueDate: "2026-10-01T12:59:59.999Z" }); // done: never overdue

    const first = sweep();
    expect(first.errors).toEqual([]);
    expect(first.overdueJobIds).toEqual([late.id]);
    const [evt] = eventsOf("job.became_overdue");
    expect(evt).toMatchObject({ jobId: late.id, actorUserId: null, action: "flagged", newValue: { dueDate: "2026-10-07T12:59:59.999Z" } });
    expect(evt?.metadata).toMatchObject({ cause: "sweep" });
    expect(noticesOf("job_overdue").map((n) => [n.userId, n.dedupeKey])).toEqual([
      [ids.users.editor1, `overdue:${late.id}:2026-10-07T12:59:59.999Z`],
      [ids.users.photographer1, `overdue:${late.id}:2026-10-07T12:59:59.999Z`],
    ]);
    expect(db.select().from(automationRuns).where(eq(automationRuns.automationId, rule.id)).all()).toMatchObject([
      { status: "succeeded", triggerEventId: evt?.id },
    ]);
    expect(first.automations.succeeded).toBe(1);

    fakeClock.advanceHours(1);
    expect(sweep().overdueJobIds).toEqual([]);
    expect(eventsOf("job.became_overdue")).toHaveLength(1);

    // deadline moved → re-armed; flagged again once the new deadline passes
    const version = db.$client.prepare("SELECT version FROM jobs WHERE id = ?").get(late.id) as { version: number };
    run((tx) => setDueDate(tx, ctxOf("manager"), { jobId: late.id, expectedVersion: version.version, value: "2026-10-09" }));
    expect(sweep().overdueJobIds).toEqual([]);
    fakeClock.set("2026-10-10T00:00:00.000Z");
    expect(sweep().overdueJobIds.sort()).toEqual([late.id, later.id].sort());
    expect(eventsOf("job.became_overdue", late.id).map((e) => (e.newValue as { dueDate: string }).dueDate)).toEqual([
      "2026-10-07T12:59:59.999Z",
      "2026-10-09T12:59:59.999Z",
    ]);
    expect(noticesOf("job_overdue").filter((n) => n.jobId === late.id)).toHaveLength(4);
    expectClean();
  });
});

describe("job.review_overdue", () => {
  it("emits once per (job, reviewDueDate) and notifies photographer + managers", () => {
    const job = insertJobFixture(db, ids, { statusKey: "review", reviewDueDate: "2026-10-07T00:00:00.000Z" }).job;
    insertJobFixture(db, ids, { statusKey: "in_progress", reviewDueDate: "2026-10-07T00:00:00.000Z" }); // not reviewer-held
    expect(sweep().reviewOverdueJobIds).toEqual([job.id]);
    expect(sweep().reviewOverdueJobIds).toEqual([]);
    expect(eventsOf("job.review_overdue")).toMatchObject([{ jobId: job.id, newValue: { reviewDueDate: "2026-10-07T00:00:00.000Z" } }]);
    expect(noticesOf("review_overdue").map((n) => n.userId).sort()).toEqual([ids.users.manager, ids.users.owner, ids.users.photographer1].sort());
    expectClean();
  });
});

describe("workload bands", () => {
  it("emits user.workload_band_changed only when the band changes; notifies managers and fires workload_threshold rules", () => {
    const rule = run((tx) =>
      createAutomation(tx, ctxOf("owner"), {
        name: "Overloaded → tell the editor",
        trigger: { type: "workload_threshold", band: "overloaded" },
        actions: [{ type: "notify", target: "editor", message: "Your queue is overloaded" }],
      }),
    );
    // 3 overdue jobs → forced overloaded (overdue cap)
    for (let i = 0; i < 3; i++) insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor2, dueDate: "2026-10-06T12:59:59.999Z" });

    const first = sweep();
    expect(first.bandChanges).toEqual([{ userId: ids.users.editor2, from: "healthy", to: "overloaded" }]);
    const [evt] = eventsOf("user.workload_band_changed");
    expect(evt).toMatchObject({ entityType: "user", entityId: ids.users.editor2, jobId: null, visibility: "management", previousValue: { band: "healthy" } });
    expect(evt?.newValue).toMatchObject({ band: "overloaded", active: 3 });
    expect(evt?.summary).toContain("Ed Editor");
    expect(noticesOf("workload_threshold").map((n) => n.userId).sort()).toEqual([ids.users.manager, ids.users.owner].sort());
    expect(noticesOf("automation")).toMatchObject([{ userId: ids.users.editor2, body: "Your queue is overloaded", linkPath: `/team/users/${ids.users.editor2}` }]);
    expect(db.select().from(automationRuns).where(eq(automationRuns.automationId, rule.id)).all()).toMatchObject([{ status: "succeeded", jobId: null }]);

    fakeClock.advanceHours(1);
    expect(sweep().bandChanges).toEqual([]);
    expect(eventsOf("user.workload_band_changed")).toHaveLength(1);

    // thresholds relaxed → back to healthy: one event, no threshold notification
    db.update(organisationSettings).set({ maxActiveJobsPerEditor: 50 }).where(eq(organisationSettings.organisationId, ids.organisationId)).run();
    const due = db.$client.prepare("SELECT id, version FROM jobs WHERE editor_id = ?").all(ids.users.editor2) as { id: string; version: number }[];
    for (const j of due) run((tx) => setDueDate(tx, ctxOf("manager"), { jobId: j.id, expectedVersion: j.version, value: "2026-11-30" }));
    expect(sweep().bandChanges).toEqual([{ userId: ids.users.editor2, from: "overloaded", to: "healthy" }]);
    expect(noticesOf("workload_threshold")).toHaveLength(2);
    expectClean();
  });
});

describe("editor_unavailable + session timeout + scheduling", () => {
  it("notifies managers about active jobs held by a deactivated editor, once per civil day", () => {
    insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.inactiveEditor });
    const first = sweep();
    expect(first.editorUnavailable).toMatchObject([{ editorId: ids.users.inactiveEditor, notified: 2 }]);
    expect(sweep().editorUnavailable).toMatchObject([{ editorId: ids.users.inactiveEditor, notified: 0 }]);
    expect(noticesOf("editor_unavailable")).toHaveLength(2);
    fakeClock.advanceDays(1);
    sweep();
    expect(noticesOf("editor_unavailable")).toHaveLength(4);
  });

  it("auto-closes work sessions older than the org timeout at started_at + timeout", () => {
    const job = insertJobFixture(db, ids, { statusKey: "in_progress" }).job;
    const { session } = run((tx) => startTimer(tx, ctxOf("editor1"), { jobId: job.id }));
    fakeClock.advanceHours(9);
    expect(sweep().timedOutSessionIds).toEqual([]);
    fakeClock.advanceHours(2); // 11 h > 600 min
    expect(sweep().timedOutSessionIds).toEqual([session.id]);
    const row = db.select().from(workSessions).where(eq(workSessions.id, session.id)).get();
    expect(row).toMatchObject({ endReason: "auto_timeout", endedAt: "2026-10-08T10:00:00.000Z", durationSeconds: 36_000 });
    expectClean();
  });

  it("maybeRunSweep runs at most once per SWEEP_MIN_INTERVAL_MINUTES and stamps last_overdue_sweep_at", () => {
    expect(maybeRunSweep(db, ids.organisationId)).not.toBeNull();
    const stamped = db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, ids.organisationId)).get();
    expect(stamped?.lastOverdueSweepAt).toBe("2026-10-08T00:00:00.000Z");
    expect(stamped?.version).toBe(1);
    fakeClock.advanceMinutes(4);
    expect(maybeRunSweep(db, ids.organisationId)).toBeNull();
    fakeClock.advanceMinutes(1);
    expect(maybeRunSweep(db, ids.organisationId)).not.toBeNull();
  });

  it("requires system.sweep for humans; the system context may sweep; stale pending runs are replayed", () => {
    for (const actor of ["editor1", "photographer1"] as const) {
      let err: unknown;
      try {
        runSweep(db, ctxOf(actor));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(403);
    }
    run((tx) =>
      createAutomation(tx, ctxOf("manager"), { name: "New job", trigger: { type: "job_created" }, actions: [{ type: "notify", target: "photographer" }] }),
    );
    insertJobFixture(db, ids);
    fakeClock.advanceMinutes(2);
    const res = runSweep(db, systemContextFor(db, ids.organisationId));
    expect(res.replayed).toMatchObject({ processed: 1, succeeded: 1 });
    expect(res.automations.processed).toBe(0);
  });
});
