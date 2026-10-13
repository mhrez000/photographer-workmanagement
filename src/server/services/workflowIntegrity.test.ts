/**
 * Batch "workflow integrity" regressions:
 *  - revision assignee = job editor (PATCH /api/revisions/:id reassigns the job)
 *  - restore / reopen with a deactivated editor never leaves an unflagged inactive holder
 *  - reassigning a job with an open revision sends the new editor revision_requested
 *  - automations never double-notify a recipient the built-in notice already covered
 *  - milestone events carry the matching action
 *  - post-commit notification channels
 */
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, setDbOverride, type Tx } from "@/db/index";
import { activityEvents, jobAssignments, jobRevisions, jobs, notifications } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, optInAllNotifications, seedMinimalOrg, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import type { AuthContext, Job, Notification } from "@/lib/types";
import { AppError } from "@/server/errors";
import { withTx } from "./_shared";
import { assignEditor } from "./assignments";
import { runPendingAutomations } from "./automationEngine";
import { createAutomation } from "./automations";
import { dispatchPendingNotifications, notify, registerNotificationChannel, type NotificationRecipient } from "./notifications";
import { requestRevision, resolveRevision, updateRevision } from "./revisions";
import { runSweep } from "./sweep";
import { deactivateUser } from "./users";
import {
  acceptJob,
  approveJob,
  beginReview,
  cancelJob,
  completeJob,
  declineJob,
  deliverJob,
  loadVisibleJob,
  reopenJob,
  restoreJob,
  startJob,
  submitJob,
  transitionJobStatus,
} from "./workflow";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  // The simplified defaults (plan §8) turn most per-type notices off; these tests check the notices themselves.
  await optInAllNotifications(db, ids);
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => Promise<T> | T): Promise<T> => withTx(fn, { db });
/** Runs `fn` as `actor`; the context is built from the root db BEFORE the transaction opens. */
async function as<T>(actor: FixtureUserKey, fn: (tx: Tx, ctx: AuthContext) => Promise<T>): Promise<T> {
  const ctx = await ctxOf(actor);
  return run((tx) => fn(tx, ctx));
}
const jobRow = async (id: string): Promise<Job> => (await first(db.select().from(jobs).where(eq(jobs.id, id)))) as Job;
const v = async (id: string): Promise<number> => (await jobRow(id)).version;
/** Calls a `(tx, ctx, { jobId, expectedVersion, … })` service with the job's CURRENT version. */
async function act<R>(actor: FixtureUserKey, svc: (tx: Tx, ctx: AuthContext, input: unknown) => Promise<R>, jobId: string, extra: Record<string, unknown> = {}): Promise<R> {
  const expectedVersion = await v(jobId);
  return as(actor, (tx, ctx) => svc(tx, ctx, { jobId, expectedVersion, ...extra }));
}
const noticesOn = (jobId: string): Promise<Notification[]> =>
  db.select().from(notifications).where(eq(notifications.jobId, jobId)).orderBy(asc(notifications.createdAt));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function catchErr(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}
async function expectClean() {
  const report = await verifyDerived(db);
  expect(report.drift).toEqual([]);
  expect(report.structural).toEqual([]);
}
const revisionPayload = { reason: "Colour", description: "Kitchen too cold", instructions: "Warm it up" };
async function jobInRevision(): Promise<{ job: Job; revisionId: string }> {
  const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
  const res = await as("coAdmin", (tx, ctx) => requestRevision(tx, ctx, { jobId: job.id, expectedVersion: job.version, ...revisionPayload }));
  return { job: await jobRow(job.id), revisionId: res.revision.id };
}

/* ------------------------------------------------------------------ */
/*  1. revision assignee diverging from the job editor                 */
/* ------------------------------------------------------------------ */

describe("updateRevision: a new assignee takes over the job", () => {
  it("reassigns the job, keeps it visible to the new editor and notifies only people who can open it", async () => {
    const { job, revisionId } = await jobInRevision();
    const before = new Set((await db.select({ id: notifications.id }).from(notifications)).map((n) => n.id));
    const res = await as("coAdmin", (tx, ctx) => updateRevision(tx, ctx, { revisionId, assigneeUserId: ids.users.editor2 }));
    expect(res.changed).toContain("assigneeUserId");
    expect(res.revision.assigneeUserId).toBe(ids.users.editor2);
    expect(await jobRow(job.id)).toMatchObject({ editorId: ids.users.editor2, previousEditorId: ids.users.editor1, statusCategory: "revision" });
    // the new editor can open the job and is the one who resolves it
    await expect(loadVisibleJob(db, await ctxOf("editor2"), job.id)).resolves.toBeDefined();
    const after = (await db.select().from(notifications)).filter((n) => !before.has(n.id));
    expect(after.length).toBeGreaterThan(0);
    for (const n of after) {
      const recipient = await contextFor(db, n.userId);
      await expect(loadVisibleJob(db, recipient, job.id), `${n.type} to ${n.userId}`).resolves.toBeDefined();
    }
    const toNew = after.filter((n) => n.userId === ids.users.editor2);
    expect(toNew.map((n) => n.type)).toEqual(["revision_requested"]);
    expect(toNew[0].title).toMatch(/Revision #1 on PJ-\d+ is now assigned to you/);
    const expectedVersion = await v(job.id);
    await as("editor2", (tx, ctx) => resolveRevision(tx, ctx, { revisionId, expectedVersion }));
    expect((await jobRow(job.id)).statusCategory).toBe("resubmitted");
    await expectClean();
  });

  it("needs job-assignment rights: an editor gets 403 and nothing changes; the job's photographer may hand it over", async () => {
    const { job, revisionId } = await jobInRevision();
    const err = await catchErr(as("editor1", (tx, ctx) => updateRevision(tx, ctx, { revisionId, assigneeUserId: ids.users.editor2 })));
    expect(err.status).toBe(403);
    expect((await jobRow(job.id)).editorId).toBe(ids.users.editor1);
    expect((await first(db.select().from(jobRevisions).where(eq(jobRevisions.id, revisionId))))?.assigneeUserId).toBe(ids.users.editor1);
    // job.assign_editor is an own-job right for photographers (same as the revision-request path)
    await as("photographer1", (tx, ctx) => updateRevision(tx, ctx, { revisionId, assigneeUserId: ids.users.editor2 }));
    expect((await jobRow(job.id)).editorId).toBe(ids.users.editor2);
    await expectClean();
  });

  it("still rejects inactive users and non-editors", async () => {
    const { revisionId } = await jobInRevision();
    for (const userId of [ids.users.inactiveEditor, ids.users.photographer2]) {
      const err = await catchErr(as("coAdmin", (tx, ctx) => updateRevision(tx, ctx, { revisionId, assigneeUserId: userId })));
      expect([400, 422]).toContain(err.status);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  5. reassigning a job with an open revision                         */
/* ------------------------------------------------------------------ */

describe("assignEditor with an open revision", () => {
  it("sends the new editor revision_requested (not a generic job_assigned)", async () => {
    const { job } = await jobInRevision();
    await as("coAdmin", (tx, ctx) => assignEditor(tx, ctx, { jobId: job.id, userId: ids.users.editor2, reason: "Rebalance" }));
    const toNew = (await noticesOn(job.id)).filter((n) => n.userId === ids.users.editor2);
    expect(toNew.map((n) => n.type)).toEqual(["revision_requested"]);
    expect(toNew[0].body).toContain("Colour");
    expect(toNew[0].linkPath).toBe(`/jobs/${job.id}#revision-1`);
    expect((await first(db.select().from(jobRevisions).where(eq(jobRevisions.jobId, job.id))))?.assigneeUserId).toBe(ids.users.editor2);
    await expectClean();
  });

  it("covers the deactivation hand-over too", async () => {
    const { job } = await jobInRevision();
    await as("owner", (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, reassignTo: ids.users.editor2, expectedVersion: 1 }));
    const toNew = (await noticesOn(job.id)).filter((n) => n.userId === ids.users.editor2);
    expect(toNew.map((n) => n.type)).toEqual(["revision_requested"]);
    await expectClean();
  });

  it("covers the 'repeat revision: back to the original editor' automation", async () => {
    await as("coAdmin", (tx, ctx) =>
      createAutomation(tx, ctx, {
        name: "Repeat revision",
        trigger: { type: "revision_requested" },
        conditions: [{ field: "revisionCount", op: "gte", value: 2 }],
        actions: [{ type: "assign_editor", target: "original_editor" }],
      }),
    );
    const { job, revisionId } = await jobInRevision();
    await as("coAdmin", (tx, ctx) => assignEditor(tx, ctx, { jobId: job.id, userId: ids.users.editor2 }));
    let expectedVersion = await v(job.id);
    await as("editor2", (tx, ctx) => resolveRevision(tx, ctx, { revisionId, expectedVersion }));
    expectedVersion = await v(job.id);
    await as("coAdmin", (tx, ctx) => requestRevision(tx, ctx, { jobId: job.id, expectedVersion, ...revisionPayload, reason: "Cropping" }));
    await runPendingAutomations(db, ids.organisationId);
    expect((await jobRow(job.id)).editorId).toBe(ids.users.editor1);
    const rev2 = await first(db.select().from(jobRevisions).where(and(eq(jobRevisions.jobId, job.id), eq(jobRevisions.revisionNumber, 2))));
    expect(rev2?.assigneeUserId).toBe(ids.users.editor1);
    const forRev2 = (await noticesOn(job.id)).filter((n) => n.userId === ids.users.editor1 && n.title.startsWith("Revision #2"));
    expect(forRev2.map((n) => n.type)).toEqual(["revision_requested"]);
    await expectClean();
  });
});

/* ------------------------------------------------------------------ */
/*  2. restore / reopen with a deactivated editor                      */
/* ------------------------------------------------------------------ */

describe("restore / reopen after the editor was deactivated", () => {
  const deactivateEditor1 = () => as("owner", (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, expectedVersion: 1 }));
  const expectReleased = async (jobId: string, category: string) => {
    expect(await jobRow(jobId)).toMatchObject({ statusCategory: category, editorId: null, previousEditorId: ids.users.editor1 });
    const editorRows = await db
      .select()
      .from(jobAssignments)
      .where(and(eq(jobAssignments.jobId, jobId), eq(jobAssignments.role, "editor")))
      .orderBy(asc(jobAssignments.rowid));
    expect(editorRows.at(-1)?.unassignReason).toBe("user_deactivated");
    const statusEvents = await db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.jobId, jobId), eq(activityEvents.eventType, "job.status_changed")))
      .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));
    expect(statusEvents.at(-1)?.metadata).toMatchObject({ releasedInactiveEditorId: ids.users.editor1, releaseReason: "editor_deactivated" });
    await expectClean();
  };

  it.each(["submitted", "approved"])("restore into %s releases the inactive editor (0 structural issues)", async (statusKey) => {
    const { job } = await insertJobFixture(db, ids, { statusKey });
    await as("coAdmin", (tx, ctx) => cancelJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, reason: "Client paused" }));
    await deactivateEditor1();
    const res = await act("coAdmin", restoreJob, job.id);
    expect(res.toStatus.category).toBe(statusKey);
    await expectReleased(job.id, statusKey);
    const restored = await first(db.select().from(activityEvents).where(and(eq(activityEvents.jobId, job.id), eq(activityEvents.eventType, "job.restored"))));
    expect(restored?.metadata).toMatchObject({ releasedInactiveEditorId: ids.users.editor1 });
  });

  it("reopen into approved releases the inactive editor (0 structural issues)", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "completed" });
    await deactivateEditor1();
    await as("coAdmin", (tx, ctx) => reopenJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, reason: "Wrong gallery", toCategory: "approved" }));
    await expectReleased(job.id, "approved");
  });

  it("a reopen (override) into submitted applies the same rule", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "completed" });
    await deactivateEditor1();
    await as("coAdmin", (tx, ctx) =>
      transitionJobStatus(tx, ctx, { jobId: job.id, toStatusId: ids.statuses.submitted, override: true, reason: "Back to review", expectedVersion: job.version }),
    );
    await expectReleased(job.id, "submitted");
  });

  it("reopen into an editor stage still needs an active editor (422)", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "completed" });
    await deactivateEditor1();
    const err = await catchErr(as("coAdmin", (tx, ctx) => reopenJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, reason: "More edits" })));
    expect(err.status).toBe(422);
    expect(await jobRow(job.id)).toMatchObject({ statusCategory: "completed", editorId: ids.users.editor1 });
  });
});

/* ------------------------------------------------------------------ */
/*  4. automation notify never duplicates a built-in notice            */
/* ------------------------------------------------------------------ */

describe("automation notify dedupe", () => {
  const rule = (input: Record<string, unknown>) => as("coAdmin", (tx, ctx) => createAutomation(tx, ctx, input));

  it("submit: the photographer gets exactly one notification, even with a rule targeting them", async () => {
    // the pre-fix seed rule (worst case) and the new seed rule
    await rule({ name: "Submitted: photographer", trigger: { type: "status_changed", toCategory: "submitted" }, actions: [{ type: "notify", target: "photographer", message: "Edits ready" }] });
    await rule({ name: "Submitted: admins", trigger: { type: "status_changed", toCategory: "submitted" }, actions: [{ type: "notify", target: "admins", message: "Edits ready" }] });
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress", createdByUserId: ids.users.photographer1 });
    await as("editor1", (tx, ctx) => submitJob(tx, ctx, { jobId: job.id, expectedVersion: job.version }));
    await runPendingAutomations(db, ids.organisationId);
    const notices = await noticesOn(job.id);
    const perUser = (userId: string) => notices.filter((n) => n.userId === userId).map((n) => n.type);
    expect(perUser(ids.users.photographer1)).toEqual(["work_submitted"]);
    expect(perUser(ids.users.coAdmin)).toEqual(["automation"]);
    expect(perUser(ids.users.owner)).toEqual(["automation"]);
  });

  it("overdue: one notification per recipient", async () => {
    await rule({
      name: "Overdue: editor and admins",
      trigger: { type: "job_overdue" },
      actions: [
        { type: "notify", target: "editor", message: "Overdue" },
        { type: "notify", target: "admins", message: "Overdue" },
      ],
    });
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress", dueDate: "2026-10-07T00:00:00.000Z" });
    await runSweep(db, ids.organisationId);
    await runPendingAutomations(db, ids.organisationId);
    const counts = new Map<string, number>();
    for (const n of await noticesOn(job.id)) counts.set(n.userId, (counts.get(n.userId) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({
      [ids.users.editor1]: 1,
      [ids.users.photographer1]: 1,
      [ids.users.coAdmin]: 1,
      [ids.users.owner]: 1,
    });
  });
});

/* ------------------------------------------------------------------ */
/*  7. milestone action taxonomy                                       */
/* ------------------------------------------------------------------ */

describe("milestone events carry the matching action", () => {
  const actionOf = async (jobId: string, type: string) =>
    (
      await first(
        db
          .select({ a: activityEvents.action })
          .from(activityEvents)
          .where(and(eq(activityEvents.jobId, jobId), eq(activityEvents.eventType, type)))
          .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid))
          .limit(1),
      )
    )?.a;

  it("a full lifecycle (+ reopen) writes job.<milestone> with action <milestone>", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    await act("editor1", acceptJob, job.id);
    await act("editor1", startJob, job.id);
    await act("editor1", submitJob, job.id);
    await act("coAdmin", beginReview, job.id);
    await act("coAdmin", approveJob, job.id);
    await act("coAdmin", deliverJob, job.id);
    await act("coAdmin", completeJob, job.id);
    await act("coAdmin", reopenJob, job.id, { reason: "Fix delivery", toCategory: "approved" });
    const types = ["job.accepted", "job.work_started", "job.submitted", "job.review_started", "job.approved", "job.delivered", "job.completed", "job.reopened"];
    const actions: [string, string | undefined][] = [];
    for (const t of types) actions.push([t, await actionOf(job.id, t)]);
    expect(Object.fromEntries(actions)).toEqual({
      "job.accepted": "accepted",
      "job.work_started": "started",
      "job.submitted": "submitted",
      "job.review_started": "started",
      "job.approved": "approved",
      "job.delivered": "delivered",
      "job.completed": "completed",
      "job.reopened": "reopened",
    });
  });

  it("decline / cancel / restore", async () => {
    const a = (await insertJobFixture(db, ids, { statusKey: "assigned" })).job;
    await as("editor1", (tx, ctx) => declineJob(tx, ctx, { jobId: a.id, expectedVersion: a.version }));
    const b = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job;
    await as("coAdmin", (tx, ctx) => cancelJob(tx, ctx, { jobId: b.id, expectedVersion: b.version, reason: "Client cancelled" }));
    await act("coAdmin", restoreJob, b.id);
    expect([await actionOf(a.id, "job.declined"), await actionOf(b.id, "job.cancelled"), await actionOf(b.id, "job.restored")]).toEqual(["declined", "cancelled", "restored"]);
  });
});

/* ------------------------------------------------------------------ */
/*  11. notification channels                                          */
/* ------------------------------------------------------------------ */

describe("notification channels", () => {
  it("a registered channel receives committed notifications after commit, never rolled-back ones", async () => {
    const received: { id: string; user: NotificationRecipient }[] = [];
    const unregister = registerNotificationChannel({
      id: "fake",
      deliver: (n, user) => {
        received.push({ id: n.id, user });
        return Promise.resolve();
      },
    });
    // the post-commit dispatcher reads through getDb(); point it at the test db
    setDbOverride(db);
    try {
      const ctx = await ctxOf("coAdmin");
      const sent = await run(async (tx) => {
        const r = await notify(tx, ctx, { userIds: [ids.users.editor1], type: "automation", title: "Hello", linkPath: "/" });
        expect(received).toEqual([]); // nothing is delivered inside the transaction
        return r;
      });
      // delivered by the post-commit hook (no manual dispatch needed any more)
      for (let i = 0; i < 10 && received.length === 0; i += 1) await flush();
      expect(received.map((r) => r.id)).toEqual(sent.notificationIds);
      expect(received[0].user).toMatchObject({ id: ids.users.editor1, role: "editor" });
      expect(received[0].user).not.toHaveProperty("passwordHash");
      expect(await dispatchPendingNotifications(db)).toBe(0); // queue drained

      // rolled back: dropped
      await expect(
        run(async (tx) => {
          await notify(tx, ctx, { userIds: [ids.users.editor2], type: "automation", title: "Never", linkPath: "/" });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      for (let i = 0; i < 5; i += 1) await flush();
      expect(await dispatchPendingNotifications(db)).toBe(0);
      expect(received).toHaveLength(1);
    } finally {
      unregister();
    }
  });
});
