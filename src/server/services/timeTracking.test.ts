import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, workSessions } from "@/db/schema";
import {
  contextFor,
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

function setup(timeTrackingEnabled: boolean) {
  db = makeTestDb();
  ids = seedMinimalOrg(db, { settings: { timeTrackingEnabled } });
  const fx = insertJobFixture(db, ids, { statusKey: "in_progress" });
  jobId = fx.job.id;
  transitionId = fx.transitionId;
}

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  setup(true);
});
afterEach(() => fakeClock.reset());

function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => T): T {
  const ctx = contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

function openSessions() {
  return db.select().from(workSessions).where(isNull(workSessions.endedAt)).all();
}

describe("startTimer", () => {
  it("is refused when the organisation has time tracking off", () => {
    setup(false);
    expect(() => run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }))).toThrow(ForbiddenError);
    expect(openSessions()).toHaveLength(0);
  });

  it("snapshots status, category and the open stage, and audits work_session.started", () => {
    const { session, alreadyRunning } = run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId, note: "colour pass" }));
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
    const ev = db.select().from(activityEvents).where(eq(activityEvents.eventType, "work_session.started")).get();
    expect(ev).toMatchObject({ entityType: "work_session", entityId: session.id, jobId, action: "started" });
    expect(ev?.newValue).toEqual({ sessionId: session.id, statusId: ids.statuses.in_progress, category: "in_progress", transitionId });
  });

  it("allows one running timer per user: same job → idempotent, other job → 409 unless switching", () => {
    const other = insertJobFixture(db, ids, { statusKey: "revision" }).job.id;
    const first = run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    const again = run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    expect(again).toMatchObject({ alreadyRunning: true, session: { id: first.session.id } });

    expect(() => run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId: other }))).toThrow(ConflictError);
    expect(openSessions()).toHaveLength(1);

    fakeClock.advanceMinutes(20);
    const switched = run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId: other, switchFromRunning: true }));
    expect(switched.stopped).toMatchObject({ id: first.session.id, endReason: "stopped", durationSeconds: 1200 });
    expect(openSessions().map((s) => s.jobId)).toEqual([other]);

    // The partial unique index is the last line of defence.
    expect(() =>
      db
        .insert(workSessions)
        .values({
          organisationId: ids.organisationId,
          jobId,
          userId: ids.users.editor1,
          statusIdAtStart: ids.statuses.in_progress,
          categoryAtStart: "in_progress",
          transitionId,
          startedAt: fakeClock.now(),
        })
        .run(),
    ).toThrow();
  });

  it("applies timer.use scope: editors only on assigned jobs in EDITOR_WORKING; no terminal or paused jobs", () => {
    expect(() => run(ids.users.editor2, (tx, ctx) => startTimer(tx, ctx, { jobId }))).toThrow(NotFoundError); // invisible job → 404
    const assigned = insertJobFixture(db, ids, { statusKey: "assigned" }).job.id;
    expect(() => run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId: assigned }))).toThrow(ForbiddenError);
    const completed = insertJobFixture(db, ids, { statusKey: "completed" }).job.id;
    expect(() => run(ids.users.photographer1, (tx, ctx) => startTimer(tx, ctx, { jobId: completed }))).toThrow(ValidationError);
    const paused = insertJobFixture(db, ids, { statusKey: "in_progress", isPaused: true }).job.id;
    expect(() => run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId: paused }))).toThrow(ValidationError);
    // photographer may time own jobs
    expect(run(ids.users.photographer1, (tx, ctx) => startTimer(tx, ctx, { jobId })).session.userId).toBe(ids.users.photographer1);
  });
});

describe("pauseTimer / stopTimer", () => {
  it("closes the running session with a fill-once duration and audits work_session.ended", () => {
    run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    fakeClock.advanceMinutes(30);
    const paused = run(ids.users.editor1, (tx, ctx) => pauseTimer(tx, ctx, { note: "lunch" }));
    expect(paused).toMatchObject({ endReason: "paused", durationSeconds: 1800, endedAt: fakeClock.now(), note: "lunch" });

    fakeClock.advanceMinutes(5);
    run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    fakeClock.advanceMinutes(15);
    const stopped = run(ids.users.editor1, (tx, ctx) => stopTimer(tx, ctx, { jobId }));
    expect(stopped).toMatchObject({ endReason: "stopped", durationSeconds: 900 });

    const ended = db.select().from(activityEvents).where(eq(activityEvents.eventType, "work_session.ended")).all();
    expect(ended.map((e) => e.action)).toEqual(["paused", "stopped"]);
    expect(ended[0].newValue).toMatchObject({ durationSeconds: 1800, endReason: "paused" });
    expect(ended[0].metadata).toMatchObject({ closedBy: "user", sessionId: paused.id });

    expect(() => db.update(workSessions).set({ durationSeconds: 1 }).where(eq(workSessions.id, paused.id)).run()).toThrow();
  });

  it("404 when nothing is running; managers may stop someone else's timer, photographers may not", () => {
    expect(() => run(ids.users.editor1, (tx, ctx) => stopTimer(tx, ctx, {}))).toThrow(NotFoundError);
    const { session } = run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    expect(() => run(ids.users.photographer1, (tx, ctx) => stopTimer(tx, ctx, { sessionId: session.id }))).toThrow(ForbiddenError);
    const stopped = run(ids.users.manager, (tx, ctx) => stopTimer(tx, ctx, { sessionId: session.id }));
    expect(stopped.endReason).toBe("stopped");
    const ev = db.select().from(activityEvents).where(eq(activityEvents.eventType, "work_session.ended")).get();
    expect(ev?.metadata).toMatchObject({ onBehalfOf: ids.users.editor1 });
  });

  it("stopping still works after the organisation turns tracking off", () => {
    run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    const ctx = { ...contextFor(db, ids.users.editor1) };
    ctx.settings = { ...ctx.settings, timeTrackingEnabled: false };
    expect(withTx((tx) => stopTimer(tx, ctx, {}), { db }).endReason).toBe("stopped");
  });
});

describe("engine hooks", () => {
  it("closeSessionsForJob closes every running session on the job (positional and object forms)", () => {
    run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    run(ids.users.photographer1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    fakeClock.advanceMinutes(10);
    const closed = run(ids.users.manager, (tx, ctx) => closeSessionsForJob(tx, ctx, jobId, "auto_status_change", { closedBy: "submit" }));
    expect(closed).toHaveLength(2);
    expect(closed.every((s) => s.endReason === "auto_status_change" && s.durationSeconds === 600)).toBe(true);
    const ev = db.select().from(activityEvents).where(eq(activityEvents.eventType, "work_session.ended")).all();
    expect(ev.map((e) => (e.metadata as { closedBy: string }).closedBy)).toEqual(["submit", "submit"]);

    expect(run(ids.users.manager, (tx, ctx) => closeSessionsForJob(tx, ctx, { jobId, reason: "auto_status_change" }))).toEqual([]);
  });

  it("closeRunningSessionForUser works from a system context and in object form", () => {
    run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    const sys = systemContextFor(db, ids.organisationId);
    const closed = withTx((tx) => closeRunningSessionForUser(tx, sys, ids.users.editor1, "auto_reassigned"), { db });
    expect(closed?.endReason).toBe("auto_reassigned");
    expect(withTx((tx) => closeRunningSessionForUser(tx, sys, { userId: ids.users.editor1, reason: "auto_deactivated" }), { db })).toBeNull();
    const ev = db.select().from(activityEvents).where(eq(activityEvents.eventType, "work_session.ended")).get();
    expect(ev).toMatchObject({ actorUserId: null });
    expect(ev?.metadata).toMatchObject({ closedBy: "reassign" });
  });

  it("closeTimedOutSessions ends stale sessions at start + timeout", () => {
    const { session } = run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    fakeClock.advanceMinutes(30);
    const sys = systemContextFor(db, ids.organisationId);
    expect(withTx((tx) => closeTimedOutSessions(tx, sys, { timeoutMinutes: 60 }), { db })).toHaveLength(0);
    fakeClock.advanceHours(2);
    const closed = withTx((tx) => closeTimedOutSessions(tx, sys, { timeoutMinutes: 60 }), { db });
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ id: session.id, endReason: "auto_timeout", durationSeconds: 3600, endedAt: "2026-10-08T01:00:00.000Z" });
  });
});

describe("reads", () => {
  it("lists sessions per visibility and totals them (running counts to now)", () => {
    run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    fakeClock.advanceMinutes(30);
    run(ids.users.editor1, (tx, ctx) => stopTimer(tx, ctx, {}));
    run(ids.users.photographer1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    fakeClock.advanceMinutes(10);

    const forPhotographer = listSessions(db, contextFor(db, ids.users.photographer1), jobId);
    expect(forPhotographer).toHaveLength(2);
    expect(forPhotographer[0]).toMatchObject({ isRunning: true, durationSeconds: 600, statusName: "In Progress" });

    const forEditor = listSessions(db, contextFor(db, ids.users.editor1), jobId);
    expect(forEditor.map((s) => s.user.id)).toEqual([ids.users.editor1]);
    expect(() => listSessions(db, contextFor(db, ids.users.editor2), jobId)).toThrow(NotFoundError); // invisible job → 404

    const totals = sessionTotals(db, contextFor(db, ids.users.manager), jobId);
    expect(totals).toMatchObject({ totalSeconds: 2400, runningCount: 1, byCategory: { in_progress: 2400 } });
    expect(totals.byUser.map((u) => [u.user.id, u.seconds])).toEqual([
      [ids.users.editor1, 1800],
      [ids.users.photographer1, 600],
    ]);
  });

  it("runningSessionFor returns the actor's running timer with its job", () => {
    expect(runningSessionFor(db, contextFor(db, ids.users.editor1))).toBeNull();
    run(ids.users.editor1, (tx, ctx) => startTimer(tx, ctx, { jobId }));
    const running = runningSessionFor(db, contextFor(db, ids.users.editor1));
    expect(running?.job.id).toBe(jobId);
    expect(running?.isRunning).toBe(true);
    expect(runningSessionFor(db, contextFor(db, ids.users.manager), ids.users.editor1)?.id).toBe(running?.id);
    expect(() => runningSessionFor(db, contextFor(db, ids.users.editor2), ids.users.editor1)).toThrow(ForbiddenError);
    expect(
      db.select().from(workSessions).where(and(eq(workSessions.userId, ids.users.editor1), isNull(workSessions.endedAt))).all(),
    ).toHaveLength(1);
  });
});
