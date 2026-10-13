import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, automationRuns, notifications, organisationSettings, workSessions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, optInAllNotifications, seedMinimalOrg, setUserFlags, systemContextFor, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import type { NotificationType } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { AppError } from "@/server/errors";
import { first, withTx } from "./_shared";
import { createAutomation } from "./automations";
import { setDueDate } from "./jobs";
import { maybeRunSweep, runSweep } from "./sweep";
import { startTimer } from "./timeTracking";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z"); // 11:00 Sydney
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
  // The simplified defaults (plan §8) turn most per-type notices off; these tests check the notices themselves.
  await optInAllNotifications(db, ids);
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
/** Builds the actor's context on the root db FIRST, then runs `fn` in one transaction. */
const runAs = async <T>(actor: FixtureUserKey, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> => {
  const ctx = await ctxOf(actor);
  return withTx((tx) => fn(tx, ctx), { db });
};
const sweep = async () => runSweep(db, await ctxOf("coAdmin"));
const eventsOf = (type: string, jobId?: string) =>
  db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.eventType, type), jobId ? eq(activityEvents.jobId, jobId) : undefined))
    .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));
const noticesOf = (type: NotificationType) => db.select().from(notifications).where(eq(notifications.type, type));

async function expectClean() {
  const report = await verifyDerived(db);
  expect(report.drift).toEqual([]);
  expect(report.structural).toEqual([]);
}

describe("job.became_overdue", () => {
  it("emits once per (job, dueDate); ONE daily late summary per person (editor, photographer, admins); job_overdue rules never double-notify; re-arms after a deadline change", async () => {
    const rule = await runAs("coAdmin", (tx, ctx) =>
      createAutomation(tx, ctx, { name: "Overdue → admins", trigger: { type: "job_overdue" }, actions: [{ type: "notify", target: "admins" }] }),
    );
    const late = (await insertJobFixture(db, ids, { statusKey: "in_progress", dueDate: "2026-10-07T12:59:59.999Z" })).job;
    const later = (await insertJobFixture(db, ids, { statusKey: "in_progress", dueDate: "2026-10-09T12:59:59.999Z" })).job; // not yet due
    await insertJobFixture(db, ids, { statusKey: "approved", dueDate: "2026-10-01T12:59:59.999Z" }); // done: never overdue

    const firstSweep = await sweep();
    expect(firstSweep.errors).toEqual([]);
    expect(firstSweep.overdueJobIds).toEqual([late.id]);
    const [evt] = await eventsOf("job.became_overdue");
    expect(evt).toMatchObject({ jobId: late.id, actorUserId: null, action: "flagged", newValue: { dueDate: "2026-10-07T12:59:59.999Z" } });
    expect(evt?.metadata).toMatchObject({ cause: "sweep" });
    // SIMPLIFICATION-PLAN §8: one "late jobs" notice per person per civil day (2026-10-08 in Sydney), not one per job.
    const firstDay = (await noticesOf("job_overdue")).sort((a, b) => a.userId.localeCompare(b.userId));
    expect(firstDay.map((n) => [n.userId, n.dedupeKey, n.title, n.jobId, n.activityEventId])).toEqual(
      [ids.users.coAdmin, ids.users.editor1, ids.users.owner, ids.users.photographer1]
        .sort()
        .map((userId) => [userId, `late_summary:${userId}:2026-10-08`, "1 job is late", late.id, evt?.id]),
    );
    // the admins' built-in summary covers the rule's "notify admins": the run succeeds without a second notice
    expect(await db.select().from(automationRuns).where(eq(automationRuns.automationId, rule.id))).toMatchObject([
      { status: "succeeded", triggerEventId: evt?.id },
    ]);
    expect(firstSweep.automations.succeeded).toBe(1);
    expect(await noticesOf("automation")).toHaveLength(0);

    fakeClock.advanceHours(1);
    expect((await sweep()).overdueJobIds).toEqual([]);
    expect(await eventsOf("job.became_overdue")).toHaveLength(1);
    expect(await noticesOf("job_overdue")).toHaveLength(4); // same day: nothing new

    // deadline moved → re-armed; flagged again once the new deadline passes
    const {
      rows: [version],
    } = await db.$client.query<{ version: number }>("SELECT version FROM jobs WHERE id = $1", [late.id]);
    await runAs("coAdmin", (tx, ctx) => setDueDate(tx, ctx, { jobId: late.id, expectedVersion: version?.version, value: "2026-10-09" }));
    expect((await sweep()).overdueJobIds).toEqual([]);
    fakeClock.set("2026-10-10T00:00:00.000Z");
    expect((await sweep()).overdueJobIds.sort()).toEqual([late.id, later.id].sort());
    expect((await eventsOf("job.became_overdue", late.id)).map((e) => (e.newValue as { dueDate: string }).dueDate)).toEqual([
      "2026-10-07T12:59:59.999Z",
      "2026-10-09T12:59:59.999Z",
    ]);
    // a new civil day (2026-10-10): one new summary each, now listing both late jobs (no single job to link to)
    const secondDay = (await noticesOf("job_overdue")).filter((n) => n.dedupeKey?.endsWith(":2026-10-10"));
    expect(secondDay).toHaveLength(4);
    for (const n of secondDay) expect(n).toMatchObject({ title: "2 jobs are late", jobId: null, activityEventId: null, linkPath: "/jobs?late=1" });
    expect(await noticesOf("job_overdue")).toHaveLength(8);
    await expectClean();
  });
});

describe("job.review_overdue", () => {
  it("emits once per (job, reviewDueDate) and notifies photographer + managers", async () => {
    const job = (await insertJobFixture(db, ids, { statusKey: "review", reviewDueDate: "2026-10-07T00:00:00.000Z" })).job;
    await insertJobFixture(db, ids, { statusKey: "in_progress", reviewDueDate: "2026-10-07T00:00:00.000Z" }); // not reviewer-held
    expect((await sweep()).reviewOverdueJobIds).toEqual([job.id]);
    expect((await sweep()).reviewOverdueJobIds).toEqual([]);
    expect(await eventsOf("job.review_overdue")).toMatchObject([{ jobId: job.id, newValue: { reviewDueDate: "2026-10-07T00:00:00.000Z" } }]);
    expect((await noticesOf("review_overdue")).map((n) => n.userId).sort()).toEqual([ids.users.coAdmin, ids.users.owner, ids.users.photographer1].sort());
    await expectClean();
  });
});

describe("workload bands", () => {
  it("emits user.workload_band_changed only when the band changes; notifies the workload watchers and fires workload_threshold rules", async () => {
    const rule = await runAs("owner", (tx, ctx) =>
      createAutomation(tx, ctx, {
        name: "Overloaded → tell the editor",
        trigger: { type: "workload_threshold", band: "overloaded" },
        actions: [{ type: "notify", target: "editor", message: "Your queue is overloaded" }],
      }),
    );
    // 3 overdue jobs → forced overloaded (overdue cap)
    for (let i = 0; i < 3; i++) await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor2, dueDate: "2026-10-06T12:59:59.999Z" });

    const firstSweep = await sweep();
    expect(firstSweep.bandChanges).toEqual([{ userId: ids.users.editor2, from: "healthy", to: "overloaded" }]);
    const [evt] = await eventsOf("user.workload_band_changed");
    expect(evt).toMatchObject({ entityType: "user", entityId: ids.users.editor2, jobId: null, visibility: "management", previousValue: { band: "healthy" } });
    expect(evt?.newValue).toMatchObject({ band: "overloaded", active: 3 });
    expect(evt?.summary).toContain("Ed Editor");
    // watchers = admins ∪ team members with "View team workload" (lead)
    expect((await noticesOf("workload_threshold")).map((n) => n.userId).sort()).toEqual([ids.users.coAdmin, ids.users.lead, ids.users.owner].sort());
    expect(await noticesOf("automation")).toMatchObject([{ userId: ids.users.editor2, body: "Your queue is overloaded", linkPath: `/team/users/${ids.users.editor2}` }]);
    expect(await db.select().from(automationRuns).where(eq(automationRuns.automationId, rule.id))).toMatchObject([{ status: "succeeded", jobId: null }]);

    fakeClock.advanceHours(1);
    expect((await sweep()).bandChanges).toEqual([]);
    expect(await eventsOf("user.workload_band_changed")).toHaveLength(1);

    // thresholds relaxed → back to healthy: one event, no threshold notification
    await db.update(organisationSettings).set({ maxActiveJobsPerEditor: 50 }).where(eq(organisationSettings.organisationId, ids.organisationId));
    const { rows: due } = await db.$client.query<{ id: string; version: number }>("SELECT id, version FROM jobs WHERE editor_id = $1 ORDER BY id", [ids.users.editor2]);
    for (const j of due) await runAs("coAdmin", (tx, ctx) => setDueDate(tx, ctx, { jobId: j.id, expectedVersion: j.version, value: "2026-11-30" }));
    expect((await sweep()).bandChanges).toEqual([{ userId: ids.users.editor2, from: "overloaded", to: "healthy" }]);
    expect(await noticesOf("workload_threshold")).toHaveLength(3);
    await expectClean();
  });
});

describe("editor_unavailable + session timeout + scheduling", () => {
  it("notifies admins (+ workload-watching members who can see the jobs) about jobs held by a deactivated editor, once per civil day", async () => {
    await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.inactiveEditor });
    // photographer2 watches workloads but cannot see photographer1's job → nothing for them
    await setUserFlags(db, ids.users.photographer2, { canViewTeamWorkloads: true });
    const firstSweep = await sweep();
    // owner + coAdmin + lead (See all jobs)
    expect(firstSweep.editorUnavailable).toMatchObject([{ editorId: ids.users.inactiveEditor, notified: 3 }]);
    expect((await noticesOf("editor_unavailable")).map((n) => n.userId).sort()).toEqual([ids.users.coAdmin, ids.users.lead, ids.users.owner].sort());
    expect((await sweep()).editorUnavailable).toMatchObject([{ editorId: ids.users.inactiveEditor, notified: 0 }]);
    expect(await noticesOf("editor_unavailable")).toHaveLength(3);
    fakeClock.advanceDays(1);
    await sweep();
    expect(await noticesOf("editor_unavailable")).toHaveLength(6);
  });

  it("auto-closes work sessions older than the org timeout at started_at + timeout", async () => {
    const job = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job;
    const { session } = await runAs("editor1", (tx, ctx) => startTimer(tx, ctx, { jobId: job.id }));
    fakeClock.advanceHours(9);
    expect((await sweep()).timedOutSessionIds).toEqual([]);
    fakeClock.advanceHours(2); // 11 h > 600 min
    expect((await sweep()).timedOutSessionIds).toEqual([session.id]);
    const row = await first(db.select().from(workSessions).where(eq(workSessions.id, session.id)));
    expect(row).toMatchObject({ endReason: "auto_timeout", endedAt: "2026-10-08T10:00:00.000Z", durationSeconds: 36_000 });
    await expectClean();
  });

  it("maybeRunSweep runs at most once per SWEEP_MIN_INTERVAL_MINUTES and stamps last_overdue_sweep_at", async () => {
    expect(await maybeRunSweep(db, ids.organisationId)).not.toBeNull();
    const stamped = await first(db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, ids.organisationId)));
    expect(stamped?.lastOverdueSweepAt).toBe("2026-10-08T00:00:00.000Z");
    expect(stamped?.version).toBe(1);
    fakeClock.advanceMinutes(4);
    expect(await maybeRunSweep(db, ids.organisationId)).toBeNull();
    fakeClock.advanceMinutes(1);
    expect(await maybeRunSweep(db, ids.organisationId)).not.toBeNull();
  });

  it("requires system.sweep for humans; the system context may sweep; stale pending runs are replayed", async () => {
    for (const actor of ["editor1", "photographer1"] as const) {
      let err: unknown;
      try {
        await runSweep(db, await ctxOf(actor));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(403);
    }
    await runAs("coAdmin", (tx, ctx) =>
      createAutomation(tx, ctx, { name: "New job", trigger: { type: "job_created" }, actions: [{ type: "notify", target: "photographer" }] }),
    );
    await insertJobFixture(db, ids);
    fakeClock.advanceMinutes(2);
    const res = await runSweep(db, await systemContextFor(db, ids.organisationId));
    expect(res.replayed).toMatchObject({ processed: 1, succeeded: 1 });
    expect(res.automations.processed).toBe(0);
  });
});
