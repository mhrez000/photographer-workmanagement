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
import type { Tx } from "@/db/index";
import { activityEvents, jobAssignments, jobRevisions, jobs, notifications } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import type { Job, Notification } from "@/lib/types";
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

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => T): T => withTx(fn, { db });
const jobRow = (id: string): Job => db.select().from(jobs).where(eq(jobs.id, id)).get() as Job;
const v = (id: string) => jobRow(id).version;
const noticesOn = (jobId: string): Notification[] =>
  db.select().from(notifications).where(eq(notifications.jobId, jobId)).orderBy(asc(notifications.createdAt)).all();
function catchErr(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}
function expectClean() {
  const report = verifyDerived(db.$client);
  expect(report.drift).toEqual([]);
  expect(report.structural).toEqual([]);
}
const revisionPayload = { reason: "Colour", description: "Kitchen too cold", instructions: "Warm it up" };
function jobInRevision(): { job: Job; revisionId: string } {
  const { job } = insertJobFixture(db, ids, { statusKey: "submitted" });
  const res = run((tx) => requestRevision(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: job.version, ...revisionPayload }));
  return { job: jobRow(job.id), revisionId: res.revision.id };
}

/* ------------------------------------------------------------------ */
/*  1. revision assignee diverging from the job editor                 */
/* ------------------------------------------------------------------ */

describe("updateRevision: a new assignee takes over the job", () => {
  it("reassigns the job, keeps it visible to the new editor and notifies only people who can open it", () => {
    const { job, revisionId } = jobInRevision();
    const marker = db.select().from(notifications).all().length;
    const res = run((tx) => updateRevision(tx, ctxOf("manager"), { revisionId, assigneeUserId: ids.users.editor2 }));
    expect(res.changed).toContain("assigneeUserId");
    expect(res.revision.assigneeUserId).toBe(ids.users.editor2);
    expect(jobRow(job.id)).toMatchObject({ editorId: ids.users.editor2, previousEditorId: ids.users.editor1, statusCategory: "revision" });
    // the new editor can open the job and is the one who resolves it
    expect(() => loadVisibleJob(db, ctxOf("editor2"), job.id)).not.toThrow();
    const after = db.select().from(notifications).all().slice(marker);
    expect(after.length).toBeGreaterThan(0);
    for (const n of after) {
      const recipient = contextFor(db, n.userId);
      expect(() => loadVisibleJob(db, recipient, job.id), `${n.type} to ${n.userId}`).not.toThrow();
    }
    const toNew = after.filter((n) => n.userId === ids.users.editor2);
    expect(toNew.map((n) => n.type)).toEqual(["revision_requested"]);
    expect(toNew[0].title).toMatch(/Revision #1 on PJ-\d+ is now assigned to you/);
    run((tx) => resolveRevision(tx, ctxOf("editor2"), { revisionId, expectedVersion: v(job.id) }));
    expect(jobRow(job.id).statusCategory).toBe("resubmitted");
    expectClean();
  });

  it("needs job-assignment rights: an editor gets 403 and nothing changes; the job's photographer may hand it over", () => {
    const { job, revisionId } = jobInRevision();
    const err = catchErr(() => run((tx) => updateRevision(tx, ctxOf("editor1"), { revisionId, assigneeUserId: ids.users.editor2 })));
    expect(err.status).toBe(403);
    expect(jobRow(job.id).editorId).toBe(ids.users.editor1);
    expect(db.select().from(jobRevisions).where(eq(jobRevisions.id, revisionId)).get()?.assigneeUserId).toBe(ids.users.editor1);
    // job.assign_editor is an own-job right for photographers (same as the revision-request path)
    run((tx) => updateRevision(tx, ctxOf("photographer1"), { revisionId, assigneeUserId: ids.users.editor2 }));
    expect(jobRow(job.id).editorId).toBe(ids.users.editor2);
    expectClean();
  });

  it("still rejects inactive users and non-editors", () => {
    const { revisionId } = jobInRevision();
    for (const userId of [ids.users.inactiveEditor, ids.users.photographer2]) {
      const err = catchErr(() => run((tx) => updateRevision(tx, ctxOf("manager"), { revisionId, assigneeUserId: userId })));
      expect([400, 422]).toContain(err.status);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  5. reassigning a job with an open revision                         */
/* ------------------------------------------------------------------ */

describe("assignEditor with an open revision", () => {
  it("sends the new editor revision_requested (not a generic job_assigned)", () => {
    const { job } = jobInRevision();
    run((tx) => assignEditor(tx, ctxOf("manager"), { jobId: job.id, userId: ids.users.editor2, reason: "Rebalance" }));
    const toNew = noticesOn(job.id).filter((n) => n.userId === ids.users.editor2);
    expect(toNew.map((n) => n.type)).toEqual(["revision_requested"]);
    expect(toNew[0].body).toContain("Colour");
    expect(toNew[0].linkPath).toBe(`/jobs/${job.id}#revision-1`);
    expect(db.select().from(jobRevisions).where(eq(jobRevisions.jobId, job.id)).get()?.assigneeUserId).toBe(ids.users.editor2);
    expectClean();
  });

  it("covers the deactivation hand-over too", () => {
    const { job } = jobInRevision();
    run((tx) => deactivateUser(tx, ctxOf("owner"), { userId: ids.users.editor1, reassignTo: ids.users.editor2, expectedVersion: 1 }));
    const toNew = noticesOn(job.id).filter((n) => n.userId === ids.users.editor2);
    expect(toNew.map((n) => n.type)).toEqual(["revision_requested"]);
    expectClean();
  });

  it("covers the 'repeat revision: back to the original editor' automation", () => {
    run((tx) =>
      createAutomation(tx, ctxOf("manager"), {
        name: "Repeat revision",
        trigger: { type: "revision_requested" },
        conditions: [{ field: "revisionCount", op: "gte", value: 2 }],
        actions: [{ type: "assign_editor", target: "original_editor" }],
      }),
    );
    const { job, revisionId } = jobInRevision();
    run((tx) => assignEditor(tx, ctxOf("manager"), { jobId: job.id, userId: ids.users.editor2 }));
    run((tx) => resolveRevision(tx, ctxOf("editor2"), { revisionId, expectedVersion: v(job.id) }));
    run((tx) => requestRevision(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: v(job.id), ...revisionPayload, reason: "Cropping" }));
    runPendingAutomations(db, ids.organisationId);
    expect(jobRow(job.id).editorId).toBe(ids.users.editor1);
    const rev2 = db.select().from(jobRevisions).where(and(eq(jobRevisions.jobId, job.id), eq(jobRevisions.revisionNumber, 2))).get();
    expect(rev2?.assigneeUserId).toBe(ids.users.editor1);
    const forRev2 = noticesOn(job.id).filter((n) => n.userId === ids.users.editor1 && n.title.startsWith("Revision #2"));
    expect(forRev2.map((n) => n.type)).toEqual(["revision_requested"]);
    expectClean();
  });
});

/* ------------------------------------------------------------------ */
/*  2. restore / reopen with a deactivated editor                      */
/* ------------------------------------------------------------------ */

describe("restore / reopen after the editor was deactivated", () => {
  const deactivateEditor1 = () => run((tx) => deactivateUser(tx, ctxOf("owner"), { userId: ids.users.editor1, expectedVersion: 1 }));
  const expectReleased = (jobId: string, category: string) => {
    expect(jobRow(jobId)).toMatchObject({ statusCategory: category, editorId: null, previousEditorId: ids.users.editor1 });
    const editorRows = db
      .select()
      .from(jobAssignments)
      .where(and(eq(jobAssignments.jobId, jobId), eq(jobAssignments.role, "editor")))
      .all();
    expect(editorRows.at(-1)?.unassignReason).toBe("user_deactivated");
    const statusEvents = db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.jobId, jobId), eq(activityEvents.eventType, "job.status_changed")))
      .all();
    expect(statusEvents.at(-1)?.metadata).toMatchObject({ releasedInactiveEditorId: ids.users.editor1, releaseReason: "editor_deactivated" });
    expectClean();
  };

  it.each(["submitted", "approved"])("restore into %s releases the inactive editor (0 structural issues)", (statusKey) => {
    const { job } = insertJobFixture(db, ids, { statusKey });
    run((tx) => cancelJob(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: job.version, reason: "Client paused" }));
    deactivateEditor1();
    const res = run((tx) => restoreJob(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: v(job.id) }));
    expect(res.toStatus.category).toBe(statusKey);
    expectReleased(job.id, statusKey);
    const restored = db.select().from(activityEvents).where(and(eq(activityEvents.jobId, job.id), eq(activityEvents.eventType, "job.restored"))).get();
    expect(restored?.metadata).toMatchObject({ releasedInactiveEditorId: ids.users.editor1 });
  });

  it("reopen into approved releases the inactive editor (0 structural issues)", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "completed" });
    deactivateEditor1();
    run((tx) => reopenJob(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: job.version, reason: "Wrong gallery", toCategory: "approved" }));
    expectReleased(job.id, "approved");
  });

  it("a reopen (override) into submitted applies the same rule", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "completed" });
    deactivateEditor1();
    run((tx) =>
      transitionJobStatus(tx, ctxOf("manager"), { jobId: job.id, toStatusId: ids.statuses.submitted, override: true, reason: "Back to review", expectedVersion: job.version }),
    );
    expectReleased(job.id, "submitted");
  });

  it("reopen into an editor stage still needs an active editor (422)", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "completed" });
    deactivateEditor1();
    const err = catchErr(() => run((tx) => reopenJob(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: job.version, reason: "More edits" })));
    expect(err.status).toBe(422);
    expect(jobRow(job.id)).toMatchObject({ statusCategory: "completed", editorId: ids.users.editor1 });
  });
});

/* ------------------------------------------------------------------ */
/*  4. automation notify never duplicates a built-in notice            */
/* ------------------------------------------------------------------ */

describe("automation notify dedupe", () => {
  const rule = (input: Record<string, unknown>) => run((tx) => createAutomation(tx, ctxOf("manager"), input));

  it("submit: the photographer gets exactly one notification, even with a rule targeting them", () => {
    // the pre-fix seed rule (worst case) and the new seed rule
    rule({ name: "Submitted: photographer", trigger: { type: "status_changed", toCategory: "submitted" }, actions: [{ type: "notify", target: "photographer", message: "Edits ready" }] });
    rule({ name: "Submitted: managers", trigger: { type: "status_changed", toCategory: "submitted" }, actions: [{ type: "notify", target: "managers", message: "Edits ready" }] });
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress", createdByUserId: ids.users.photographer1 });
    run((tx) => submitJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: job.version }));
    runPendingAutomations(db, ids.organisationId);
    const perUser = (userId: string) => noticesOn(job.id).filter((n) => n.userId === userId).map((n) => n.type);
    expect(perUser(ids.users.photographer1)).toEqual(["work_submitted"]);
    expect(perUser(ids.users.manager)).toEqual(["automation"]);
    expect(perUser(ids.users.owner)).toEqual(["automation"]);
  });

  it("overdue: one notification per recipient", () => {
    rule({
      name: "Overdue: editor and managers",
      trigger: { type: "job_overdue" },
      actions: [
        { type: "notify", target: "editor", message: "Overdue" },
        { type: "notify", target: "managers", message: "Overdue" },
      ],
    });
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress", dueDate: "2026-10-07T00:00:00.000Z" });
    runSweep(db, ids.organisationId);
    runPendingAutomations(db, ids.organisationId);
    const counts = new Map<string, number>();
    for (const n of noticesOn(job.id)) counts.set(n.userId, (counts.get(n.userId) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({
      [ids.users.editor1]: 1,
      [ids.users.photographer1]: 1,
      [ids.users.manager]: 1,
      [ids.users.owner]: 1,
    });
  });
});

/* ------------------------------------------------------------------ */
/*  7. milestone action taxonomy                                       */
/* ------------------------------------------------------------------ */

describe("milestone events carry the matching action", () => {
  const actionOf = (jobId: string, type: string) =>
    db
      .select({ a: activityEvents.action })
      .from(activityEvents)
      .where(and(eq(activityEvents.jobId, jobId), eq(activityEvents.eventType, type)))
      .get()?.a;

  it("a full lifecycle (+ reopen) writes job.<milestone> with action <milestone>", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "assigned" });
    const e = { jobId: job.id };
    run((tx) => acceptJob(tx, ctxOf("editor1"), { ...e, expectedVersion: v(job.id) }));
    run((tx) => startJob(tx, ctxOf("editor1"), { ...e, expectedVersion: v(job.id) }));
    run((tx) => submitJob(tx, ctxOf("editor1"), { ...e, expectedVersion: v(job.id) }));
    run((tx) => beginReview(tx, ctxOf("manager"), { ...e, expectedVersion: v(job.id) }));
    run((tx) => approveJob(tx, ctxOf("manager"), { ...e, expectedVersion: v(job.id) }));
    run((tx) => deliverJob(tx, ctxOf("manager"), { ...e, expectedVersion: v(job.id) }));
    run((tx) => completeJob(tx, ctxOf("manager"), { ...e, expectedVersion: v(job.id) }));
    run((tx) => reopenJob(tx, ctxOf("manager"), { ...e, expectedVersion: v(job.id), reason: "Fix delivery", toCategory: "approved" }));
    const types = ["job.accepted", "job.work_started", "job.submitted", "job.review_started", "job.approved", "job.delivered", "job.completed", "job.reopened"];
    expect(Object.fromEntries(types.map((t) => [t, actionOf(job.id, t)]))).toEqual({
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

  it("decline / cancel / restore", () => {
    const a = insertJobFixture(db, ids, { statusKey: "assigned" }).job;
    run((tx) => declineJob(tx, ctxOf("editor1"), { jobId: a.id, expectedVersion: a.version }));
    const b = insertJobFixture(db, ids, { statusKey: "in_progress" }).job;
    run((tx) => cancelJob(tx, ctxOf("manager"), { jobId: b.id, expectedVersion: b.version, reason: "Client cancelled" }));
    run((tx) => restoreJob(tx, ctxOf("manager"), { jobId: b.id, expectedVersion: v(b.id) }));
    expect([actionOf(a.id, "job.declined"), actionOf(b.id, "job.cancelled"), actionOf(b.id, "job.restored")]).toEqual(["declined", "cancelled", "restored"]);
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
    try {
      const ctx = ctxOf("manager");
      const sent = run((tx) => {
        const r = notify(tx, ctx, { userIds: [ids.users.editor1], type: "automation", title: "Hello", linkPath: "/" });
        expect(received).toEqual([]); // nothing is delivered inside the transaction
        return r;
      });
      expect(received).toEqual([]);
      expect(await dispatchPendingNotifications(db)).toBe(1);
      expect(received.map((r) => r.id)).toEqual(sent.notificationIds);
      expect(received[0].user).toMatchObject({ id: ids.users.editor1, role: "editor" });
      expect(received[0].user).not.toHaveProperty("passwordHash");

      // rolled back: dropped
      expect(() =>
        run((tx) => {
          notify(tx, ctx, { userIds: [ids.users.editor2], type: "automation", title: "Never", linkPath: "/" });
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(await dispatchPendingNotifications(db)).toBe(0);
      expect(received).toHaveLength(1);
    } finally {
      unregister();
    }
  });
});
