import { and, asc, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, workSessions } from "@/db/schema";
import {
  contextFor,
  dbRejection,
  fakeClock,
  insertJobFixture,
  makeTestDb,
  seedMinimalOrg,
  systemContextFor,
  type SeedIds,
  type TestDb,
} from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import {
  closeRunningSessionForUser,
  closeSessionsForJob,
  closeTimedOutSessions,
  listSessions,
  pauseTimer,
  runningSessionFor,
  sessionTotals,
  startTimer,
  stopTimer,
} from "./timeTracking";

let db: TestDb;
let ids: SeedIds;
let jobId: string;
let transitionId: string;

async function setup(timeTrackingEnabled: boolean) {
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { settings: { timeTrackingEnabled } });
  const fx = await insertJobFixture(db, ids, { statusKey: "in_progress" });
  jobId = fx.job.id;
  transitionId = fx.transitionId;
}

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  await setup(true);
});
afterEach(() => fakeClock.reset());

async function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T>): Promise<T> {
  const ctx = await contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

function openSessions() {
  return db.select().from(workSessions).where(isNull(workSessions.endedAt));
}

function endedEvents() {
  return db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.eventType, "work_session.ended"))
    .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));
}

describe("startTimer", () => {
  it("is refused when the organisation has time tracking off", async () => {
    await setup(false);
    await expect(run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }))).rejects.toThrow(ForbiddenError);
    expect(await openSessions()).toHaveLength(0);
  });

  it("snapshots status, category and the open stage, and audits work_session.started", async () => {
    const { session, alreadyRunning } = await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId, note: "colour pass" }));
    expect(alreadyRunning).toBe(false);
    expect(session).toMatchObject({
      userId: ids.users.editor1,
      statusIdAtStart: ids.statuses.in_progress,
      categoryAtStart: "in_progress",
      transitionId,
      startedAt: fakeClock.now(),
      endedAt: null,
      note: "colour pass",
    });
    const ev = await first(db.select().from(activityEvents).where(eq(activityEvents.eventType, "work_session.started")).limit(1));
    expect(ev).toMatchObject({ entityType: "work_session", entityId: session.id, jobId, action: "started" });
    expect(ev?.newValue).toEqual({ sessionId: session.id, statusId: ids.statuses.in_progress, category: "in_progress", transitionId });
  });

  it("allows one running timer per user: same job → idempotent, other job → 409 unless switching", async () => {
    const other = (await insertJobFixture(db, ids, { statusKey: "revision" })).job.id;
    const started = await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    const again = await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    expect(again).toMatchObject({ alreadyRunning: true, session: { id: started.session.id } });

    await expect(run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId: other }))).rejects.toThrow(ConflictError);
    expect(await openSessions()).toHaveLength(1);

    fakeClock.advanceMinutes(20);
    const switched = await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId: other, switchFromRunning: true }));
    expect(switched.stopped).toMatchObject({ id: started.session.id, endReason: "stopped", durationSeconds: 1200 });
    expect((await openSessions()).map((s) => s.jobId)).toEqual([other]);

    // The partial unique index is the last line of defence.
    expect(
      await dbRejection(
        db.insert(workSessions).values({
          organisationId: ids.organisationId,
          jobId,
          userId: ids.users.editor1,
          statusIdAtStart: ids.statuses.in_progress,
          categoryAtStart: "in_progress",
          transitionId,
          startedAt: fakeClock.now(),
        }),
      ),
    ).toMatch(/duplicate key|unique/i);
  });

  it("applies timer.use scope: editors only on assigned jobs in EDITOR_WORKING; no terminal or paused jobs", async () => {
    await expect(run(ids.users.editor2, (tx, ctx) => startTimer(tx, ctx, { jobId }))).rejects.toThrow(NotFoundError); // invisible job → 404
    const assigned = (await insertJobFixture(db, ids, { statusKey: "assigned" })).job.id;
    await expect(run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId: assigned }))).rejects.toThrow(ForbiddenError);
    const completed = (await insertJobFixture(db, ids, { statusKey: "completed" })).job.id;
    await expect(run(ids.users.photographer1, (tx, ctx) => startTimer(tx, ctx, { jobId: completed }))).rejects.toThrow(ValidationError);
    const paused = (await insertJobFixture(db, ids, { statusKey: "in_progress", isPaused: true })).job.id;
    await expect(run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId: paused }))).rejects.toThrow(ValidationError);
    // photographer may time own jobs
    expect((await run(ids.users.photographer1, (tx, ctx) => startTimer(tx, ctx, { jobId }))).session.userId).toBe(ids.users.photographer1);
  });
});

describe("pauseTimer / stopTimer", () => {
  it("closes the running session with a fill-once duration and audits work_session.ended", async () => {
    await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    fakeClock.advanceMinutes(30);
    const paused = await run(ids.users.editor1, (tx, ctx) => pauseTimer(tx, ctx, { note: "lunch" }));
    expect(paused).toMatchObject({ endReason: "paused", durationSeconds: 1800, endedAt: fakeClock.now(), note: "lunch" });

    fakeClock.advanceMinutes(5);
    await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    fakeClock.advanceMinutes(15);
    const stopped = await run(ids.users.editor1, (tx, ctx) => stopTimer(tx, ctx, { jobId }));
    expect(stopped).toMatchObject({ endReason: "stopped", durationSeconds: 900 });

    const ended = await endedEvents();
    expect(ended.map((e) => e.action)).toEqual(["paused", "stopped"]);
    expect(ended[0].newValue).toMatchObject({ durationSeconds: 1800, endReason: "paused" });
    expect(ended[0].metadata).toMatchObject({ closedBy: "user", sessionId: paused.id });

    expect(await dbRejection(db.update(workSessions).set({ durationSeconds: 1 }).where(eq(workSessions.id, paused.id)))).toMatch(/work session rows are immutable/);
  });

  it("404 when nothing is running; managers may stop someone else's timer, photographers may not", async () => {
    await expect(run(ids.users.editor1, (tx, ctx) => stopTimer(tx, ctx, {}))).rejects.toThrow(NotFoundError);
    const { session } = await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    await expect(run(ids.users.photographer1, (tx, ctx) => stopTimer(tx, ctx, { sessionId: session.id }))).rejects.toThrow(ForbiddenError);
    const stopped = await run(ids.users.coAdmin, (tx, ctx) => stopTimer(tx, ctx, { sessionId: session.id }));
    expect(stopped.endReason).toBe("stopped");
    const [ev] = await endedEvents();
    expect(ev?.metadata).toMatchObject({ onBehalfOf: ids.users.editor1 });
  });

  it("stopping still works after the organisation turns tracking off", async () => {
    await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    const ctx = { ...(await contextFor(db, ids.users.editor1)) };
    ctx.settings = { ...ctx.settings, timeTrackingEnabled: false };
    expect((await withTx((tx) => stopTimer(tx, ctx, {}), { db })).endReason).toBe("stopped");
  });
});

describe("engine hooks", () => {
  it("closeSessionsForJob closes every running session on the job (positional and object forms)", async () => {
    await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    await run(ids.users.photographer1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    fakeClock.advanceMinutes(10);
    const closed = await run(ids.users.coAdmin, (tx, ctx) => closeSessionsForJob(tx, ctx, jobId, "auto_status_change", { closedBy: "submit" }));
    expect(closed).toHaveLength(2);
    expect(closed.every((s) => s.endReason === "auto_status_change" && s.durationSeconds === 600)).toBe(true);
    const ev = await endedEvents();
    expect(ev.map((e) => (e.metadata as { closedBy: string }).closedBy)).toEqual(["submit", "submit"]);

    expect(await run(ids.users.coAdmin, (tx, ctx) => closeSessionsForJob(tx, ctx, { jobId, reason: "auto_status_change" }))).toEqual([]);
  });

  it("closeRunningSessionForUser works from a system context and in object form", async () => {
    await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    const sys = await systemContextFor(db, ids.organisationId);
    const closed = await withTx((tx) => closeRunningSessionForUser(tx, sys, ids.users.editor1, "auto_reassigned"), { db });
    expect(closed?.endReason).toBe("auto_reassigned");
    expect(
      await withTx((tx) => closeRunningSessionForUser(tx, sys, { userId: ids.users.editor1, reason: "auto_deactivated" }), { db }),
    ).toBeNull();
    const [ev] = await endedEvents();
    expect(ev).toMatchObject({ actorUserId: null });
    expect(ev?.metadata).toMatchObject({ closedBy: "reassign" });
  });

  it("closeTimedOutSessions ends stale sessions at start + timeout", async () => {
    const { session } = await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    fakeClock.advanceMinutes(30);
    const sys = await systemContextFor(db, ids.organisationId);
    expect(await withTx((tx) => closeTimedOutSessions(tx, sys, { timeoutMinutes: 60 }), { db })).toHaveLength(0);
    fakeClock.advanceHours(2);
    const closed = await withTx((tx) => closeTimedOutSessions(tx, sys, { timeoutMinutes: 60 }), { db });
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ id: session.id, endReason: "auto_timeout", durationSeconds: 3600, endedAt: "2026-10-08T01:00:00.000Z" });
  });
});

describe("reads", () => {
  it("lists sessions per visibility and totals them (running counts to now)", async () => {
    await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    fakeClock.advanceMinutes(30);
    await run(ids.users.editor1, (tx, ctx) => stopTimer(tx, ctx, {}));
    await run(ids.users.photographer1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    fakeClock.advanceMinutes(10);

    const forPhotographer = await listSessions(db, await contextFor(db, ids.users.photographer1), jobId);
    expect(forPhotographer).toHaveLength(2);
    expect(forPhotographer[0]).toMatchObject({ isRunning: true, durationSeconds: 600, statusName: "In Progress" });

    const forEditor = await listSessions(db, await contextFor(db, ids.users.editor1), jobId);
    expect(forEditor.map((s) => s.user.id)).toEqual([ids.users.editor1]);
    await expect(listSessions(db, await contextFor(db, ids.users.editor2), jobId)).rejects.toThrow(NotFoundError); // invisible job → 404

    const totals = await sessionTotals(db, await contextFor(db, ids.users.coAdmin), jobId);
    expect(totals).toMatchObject({ totalSeconds: 2400, runningCount: 1, byCategory: { in_progress: 2400 } });
    expect(totals.byUser.map((u) => [u.user.id, u.seconds])).toEqual([
      [ids.users.editor1, 1800],
      [ids.users.photographer1, 600],
    ]);
  });

  it("runningSessionFor returns the actor's running timer with its job", async () => {
    expect(await runningSessionFor(db, await contextFor(db, ids.users.editor1))).toBeNull();
    await run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    const running = await runningSessionFor(db, await contextFor(db, ids.users.editor1));
    expect(running?.job.id).toBe(jobId);
    expect(running?.isRunning).toBe(true);
    expect((await runningSessionFor(db, await contextFor(db, ids.users.coAdmin), ids.users.editor1))?.id).toBe(running?.id);
    await expect(runningSessionFor(db, await contextFor(db, ids.users.editor2), ids.users.editor1)).rejects.toThrow(ForbiddenError);
    expect(
      await db.select().from(workSessions).where(and(eq(workSessions.userId, ids.users.editor1), isNull(workSessions.endedAt))),
    ).toHaveLength(1);
  });
});
