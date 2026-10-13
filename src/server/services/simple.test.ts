/**
 * Simplified job actions (docs/SIMPLIFICATION-PLAN.md §4, §5, §8, §9, §12) — every composite action is
 * exercised against the real engine on PGlite: the recorded steps, the stage it lands in, the stricter
 * finished-link rule, the Approve chain (& send / only / n/a, stop at the furthest reachable step on a
 * custom workflow), owner self-approval (decision 3), Ask-for-changes defaults, both Reopen reasons,
 * silent projects + default due dates, notification defaults, Advanced tools, presets. Zero drift after
 * every scenario.
 */
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, jobLinks, jobRevisions, jobStatusTransitions, jobTypes, jobs, notifications, organisationSettings, projects, userNotificationPrefs, users, workflowStatuses } from "@/db/schema";
import {
  contextFor,
  fakeClock,
  insertDefaultWorkflow,
  insertJobFixture,
  makeTestDb,
  seedMinimalOrg,
  setUserFlags,
  type FixtureUserKey,
  type SeedIds,
  type TestDb,
} from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import { DEFAULT_OFF_NOTIFICATION_TYPES, DEFAULT_ON_NOTIFICATION_TYPES, SELF_APPROVAL_CONFIRM_MESSAGE } from "@/lib/constants";
import type { AuthContext, Job } from "@/lib/types";
import { AppError } from "@/server/errors";
import { withTx } from "./_shared";
import { createJob } from "./jobs";
import { addLink } from "./links";
import { notify } from "./notifications";
import {
  approveJob,
  approveShareChoiceFor,
  askForChanges,
  assignEditorSimple,
  cancelJobSimple,
  changeEditor,
  closeDeliveredJobs,
  declineJobSimple,
  dismissSimplerNotice,
  jobStage,
  markOldUpdatesRead,
  reopenJobSimple,
  restoreJobSimple,
  sendForChecking,
  setAdvancedTools,
  setEditorUsualCapacity,
  setJobTypeUsualDays,
  takeBackFromEditor,
} from "./simple";
import { inviteUser } from "./users";
import { startJob } from "./workflow";

let db: TestDb;
let ids: SeedIds;
const T0 = "2026-10-08T00:00:00.000Z"; // 11:00 Sydney, Thursday

beforeEach(async () => {
  fakeClock.set(T0);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => Promise<T> | T): Promise<T> => withTx(fn, { db });
/** Runs `fn` as `actor`; the context is built from the root db BEFORE the transaction opens. */
async function as<T>(actor: FixtureUserKey, fn: (tx: Tx, ctx: AuthContext) => Promise<T>): Promise<T> {
  const ctx = await ctxOf(actor);
  return run((tx) => fn(tx, ctx));
}
async function jobRow(id: string): Promise<Job> {
  const row = await first(db.select().from(jobs).where(eq(jobs.id, id)));
  if (!row) throw new Error("job missing");
  return row;
}
/** Calls a `(tx, ctx, { jobId, expectedVersion, … })` service with the job's CURRENT version. */
async function act<R>(actor: FixtureUserKey, svc: (tx: Tx, ctx: AuthContext, input: unknown) => Promise<R>, jobId: string, extra: Record<string, unknown> = {}): Promise<R> {
  const expectedVersion = (await jobRow(jobId)).version;
  return as(actor, (tx, ctx) => svc(tx, ctx, { jobId, expectedVersion, ...extra }));
}
const transitionsOf = (jobId: string) =>
  db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, jobId)).orderBy(asc(jobStatusTransitions.sequence));
const eventsOf = (jobId: string, type?: string) =>
  db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.jobId, jobId), type ? eq(activityEvents.eventType, type) : undefined))
    .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));
const linksOf = (jobId: string) => db.select().from(jobLinks).where(eq(jobLinks.jobId, jobId)).orderBy(asc(jobLinks.createdAt), asc(jobLinks.id));
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
const FINISHED = "https://drive.google.com/drive/folders/finished-v1";
const FINISHED_V2 = "https://www.dropbox.com/scl/fo/finished-v2";

/* ------------------------------------------------------------------ */
/*  Assign / change / take back / decline                              */
/* ------------------------------------------------------------------ */

describe("assignEditorSimple / changeEditor / takeBackFromEditor / declineJobSimple", () => {
  it("assign editor skips Ready: New → Assigned in one recorded move, stage With editor · Not started", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "new" });
    const res = await act("photographer1", assignEditorSimple, job.id, { editorId: ids.users.editor1 });
    expect(res.job).toMatchObject({ statusCategory: "assigned", editorId: ids.users.editor1 });
    expect(res.stage).toMatchObject({ stage: "with_editor", subLabel: "not_started", waitingOn: "editor" });
    expect((await transitionsOf(job.id)).map((t) => t.toCategory)).toEqual(["new", "assigned"]);
    expect((await db.select().from(notifications).where(eq(notifications.type, "job_assigned"))).map((n) => n.userId)).toEqual([ids.users.editor1]);
    await expectClean();
  });

  it("an editor cannot assign; a Done job cannot be assigned", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" }); // visible to editor1
    expect((await catchErr(act("editor1", assignEditorSimple, job.id, { editorId: ids.users.editor2 }))).status).toBe(403);
    const done = (await insertJobFixture(db, ids, { statusKey: "completed" })).job;
    expect((await catchErr(act("owner", assignEditorSimple, done.id, { editorId: ids.users.editor2 }))).code).toBe("invalid_transition");
  });

  it("change editor re-attributes the open stage; take back returns the job to Needs editor", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" }); // editor1
    const changed = await act("owner", changeEditor, job.id, { editorId: ids.users.editor2, reason: "Rebalancing" });
    expect(changed.job).toMatchObject({ statusCategory: "in_progress", editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    expect(changed.assignment.reattribution).not.toBeNull();
    expect(changed.stage.stage).toBe("with_editor");
    const back = await act("owner", takeBackFromEditor, job.id, { reason: "Doing it myself" });
    expect(back.job).toMatchObject({ statusCategory: "ready", editorId: null });
    expect(back.stage.stage).toBe("needs_editor");
    expect((await eventsOf(job.id, "assignment.ended")).at(-1)?.metadata.unassignReason).toBe("unassigned");
    // nothing to take back from a job without an editor; a Ready-to-check job is not "with the editor"
    expect((await catchErr(act("owner", takeBackFromEditor, job.id))).code).toBe("invalid_transition");
    const checking = (await insertJobFixture(db, ids, { statusKey: "submitted" })).job;
    expect((await catchErr(act("owner", takeBackFromEditor, checking.id))).code).toBe("invalid_transition");
    await expectClean();
  });

  it("\"Can't do this one\": the assigned editor declines a not-yet-started job with a reason; once editing started it is a 422 with advice; others are 403", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    expect((await catchErr(act("editor1", declineJobSimple, job.id, {}))).status).toBe(400); // reason required
    const res = await act("editor1", declineJobSimple, job.id, { reason: "Fully booked this week, sorry" });
    expect(res.job).toMatchObject({ statusCategory: "ready", editorId: null, previousEditorId: ids.users.editor1 });
    expect(res.stage.stage).toBe("needs_editor");
    expect((await transitionsOf(job.id)).at(-1)?.reason).toBe("Fully booked this week, sorry");
    expect(await eventsOf(job.id, "job.declined")).toHaveLength(1);
    const editing = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job;
    const err = await catchErr(act("editor1", declineJobSimple, editing.id, { reason: "Too busy" }));
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/take the job back/);
    const other = (await insertJobFixture(db, ids, { statusKey: "assigned" })).job;
    expect((await catchErr(act("editor2", declineJobSimple, other.id, { reason: "Not mine" }))).status).toBe(404); // not visible to editor2
    await expectClean();
  });
});

/* ------------------------------------------------------------------ */
/*  Start editing                                                      */
/* ------------------------------------------------------------------ */

describe("Start editing (the engine route the simple UI uses)", () => {
  it("a stale version is a 409 BEFORE any actor or stage check (the editor's page was out of date), then the editor starts: With editor · Editing", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    // Stale page + wrong actor: the version check wins, so the screen says "someone else just changed this job", not "only the assigned editor".
    const stale = await catchErr(as("photographer1", (tx, ctx) => startJob(tx, ctx, { jobId: job.id, expectedVersion: job.version + 1, startTimer: false })));
    expect(stale.status).toBe(409);
    const staleEditor = await catchErr(as("editor1", (tx, ctx) => startJob(tx, ctx, { jobId: job.id, expectedVersion: job.version + 1, startTimer: false })));
    expect(staleEditor.status).toBe(409);
    // Right version, wrong actor: 403.
    expect((await catchErr(act("photographer1", startJob, job.id, { startTimer: false }))).status).toBe(403);
    const res = await act("editor1", startJob, job.id, { startTimer: false });
    expect(res.job.statusCategory).toBe("in_progress");
    expect(jobStage(res.job)).toMatchObject({ stage: "with_editor", subLabel: "editing" });
    // The same order holds for "Can't do this one" and "Send for checking" (simple.ts): stale → 409 even for a non-actor.
    expect((await catchErr(as("photographer1", (tx, ctx) => declineJobSimple(tx, ctx, { jobId: job.id, expectedVersion: res.job.version + 1, reason: "x" })))).status).toBe(409);
    expect((await catchErr(as("photographer1", (tx, ctx) => sendForChecking(tx, ctx, { jobId: job.id, expectedVersion: res.job.version + 1, finishedLink: { url: FINISHED } })))).status).toBe(409);
    await expectClean();
  });
});

/* ------------------------------------------------------------------ */
/*  Send for checking                                                  */
/* ------------------------------------------------------------------ */

describe("sendForChecking", () => {
  it("REQUIRES a finished link: 'reuse current' with nothing there is a 422 and nothing moves", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const err = await catchErr(act("editor1", sendForChecking, job.id, { finishedLink: { reuseCurrent: true } }));
    expect(err.status).toBe(422);
    expect(err.details).toMatchObject({ fieldErrors: { finishedLink: ["Required"] } });
    expect((await jobRow(job.id)).statusCategory).toBe("in_progress");
    expect(await linksOf(job.id)).toHaveLength(0);
    // a missing / non-http link is a 400 from the schema
    expect((await catchErr(act("editor1", sendForChecking, job.id, { finishedLink: { url: "javascript:alert(1)" } }))).status).toBe(400);
    expect((await catchErr(act("editor1", sendForChecking, job.id, {}))).status).toBe(400);
  });

  it("from With editor (not started): records the link as finished_files, Start editing, Send for checking — two history rows, stage Ready to check", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    const res = await act("editor1", sendForChecking, job.id, { finishedLink: { url: FINISHED, label: "Final set" } });
    expect(res.transitions.map((t) => t.toStatus.category)).toEqual(["in_progress", "submitted"]);
    expect(res.job).toMatchObject({ statusCategory: "submitted", firstSubmittedAt: fakeClock.now(), startedAt: fakeClock.now() });
    expect(res.stage).toMatchObject({ stage: "ready_to_check", subLabel: null, round: null, waitingOn: "photographer" });
    expect(res.finishedLink).toMatchObject({ kind: "finished_files", url: FINISHED, label: "Final set", addedByUserId: ids.users.editor1 });
    expect(res.warnings).toEqual([]); // the link is there, so no "no finished files" warning
    expect((await transitionsOf(job.id)).map((t) => t.toCategory)).toEqual(["assigned", "in_progress", "submitted"]);
    expect((await eventsOf(job.id, "job.status_changed")).map((e) => (e.newValue as { category: string }).category)).toEqual(["in_progress", "submitted"]);
    expect(await eventsOf(job.id, "job.work_started")).toHaveLength(1);
    expect(await eventsOf(job.id, "job.submitted")).toHaveLength(1);
    // the photographer is told "Ready to check" (work_submitted is on by default)
    expect((await db.select().from(notifications).where(eq(notifications.type, "work_submitted"))).map((n) => n.userId)).toEqual([ids.users.photographer1]);
    await expectClean();
  });

  it("a new URL supersedes the editor's previous finished link; the same URL or 'reuse current' keeps it", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const old = await as("editor1", (tx, ctx) => addLink(tx, ctx, { jobId: job.id, kind: "finished_files", url: FINISHED }));
    const res = await act("editor1", sendForChecking, job.id, { finishedLink: { url: FINISHED_V2 } });
    expect(res.finishedLink).toMatchObject({ url: FINISHED_V2, supersedesLinkId: old.id });
    const rows = await linksOf(job.id);
    expect(rows.find((l) => l.id === old.id)).toMatchObject({ supersededAt: fakeClock.now(), supersededByLinkId: res.finishedLink.id });
    expect(rows.filter((l) => l.supersededAt === null && l.removedAt === null)).toHaveLength(1);
    // Changes asked → the same link again: no new row
    await act("owner", askForChanges, job.id, { note: "Tighter crop on the hero" });
    const again = await act("editor1", sendForChecking, job.id, { finishedLink: { url: FINISHED_V2 } });
    expect(again.finishedLink.id).toBe(res.finishedLink.id);
    expect(await linksOf(job.id)).toHaveLength(2);
    await act("owner", askForChanges, job.id, { note: "One more pass on the sky" });
    const reused = await act("editor1", sendForChecking, job.id, { finishedLink: { reuseCurrent: true }, note: "Same folder, re-exported" });
    expect(reused.finishedLink.id).toBe(res.finishedLink.id);
    expect(reused.stage).toMatchObject({ stage: "ready_to_check", subLabel: "round", round: 3 });
    const revisions = await db.select().from(jobRevisions).where(eq(jobRevisions.jobId, job.id)).orderBy(asc(jobRevisions.revisionNumber));
    expect(revisions.map((r) => [r.revisionNumber, r.resolution, r.resolutionNote])).toEqual([
      [1, "resubmitted", null],
      [2, "resubmitted", "Same folder, re-exported"],
    ]);
    await expectClean();
  });

  it("from Changes asked: resubmits (resolves the round) and shows Round 2", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    await act("owner", askForChanges, job.id, { note: "Straighten the verticals", chips: ["Straighten"] });
    expect(jobStage(await jobRow(job.id))).toMatchObject({ stage: "changes_asked", waitingOn: "editor" });
    const res = await act("editor1", sendForChecking, job.id, { finishedLink: { url: FINISHED } });
    expect(res.transitions.map((t) => t.toStatus.category)).toEqual(["resubmitted"]);
    expect(res.stage).toMatchObject({ stage: "ready_to_check", subLabel: "round", round: 2 });
    expect((await jobRow(job.id)).openRevisionId).toBeNull();
    expect((await db.select().from(notifications).where(eq(notifications.type, "work_resubmitted"))).map((n) => n.userId)).toContain(ids.users.owner);
    await expectClean();
  });

  it("only the assigned editor (or an admin on their behalf) sends; wrong stages are 422", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    expect((await catchErr(act("editor2", sendForChecking, job.id, { finishedLink: { url: FINISHED } }))).status).toBe(404);
    expect((await catchErr(act("photographer1", sendForChecking, job.id, { finishedLink: { url: FINISHED } }))).status).toBe(403);
    const checking = (await insertJobFixture(db, ids, { statusKey: "submitted" })).job;
    expect((await catchErr(act("editor1", sendForChecking, checking.id, { finishedLink: { url: FINISHED } }))).code).toBe("invalid_transition");
    const onBehalf = await act("owner", sendForChecking, job.id, { finishedLink: { url: FINISHED } });
    expect(onBehalf.job.statusCategory).toBe("submitted");
    expect((await eventsOf(job.id, "job.submitted"))[0].metadata.onBehalfOf).toBe(ids.users.editor1);
    await expectClean();
  });
});

/* ------------------------------------------------------------------ */
/*  Approve                                                            */
/* ------------------------------------------------------------------ */

describe("approveJob", () => {
  async function readyJob(key: string = "submitted") {
    const { job } = await insertJobFixture(db, ids, { statusKey: key });
    const link = await as("owner", (tx, ctx) => addLink(tx, ctx, { jobId: job.id, kind: "finished_files", url: FINISHED }));
    return { job, link };
  }

  it("Approve & send records Approved → Delivered → Completed as three history rows in one go, shares the job + chosen links and tells the client", async () => {
    const { job, link } = await readyJob();
    const res = await act("owner", approveJob, job.id, { share: "send", shareLinkIds: [link.id] });
    expect(res.steps.map((s) => s.toStatus.category)).toEqual(["approved", "delivered", "completed"]);
    expect(res).toMatchObject({ stoppedAt: "completed", notSentToClient: false, sharedWithClient: true, selfApproved: false });
    expect(res.stage).toMatchObject({ stage: "done", subLabel: null, waitingOn: "nobody", active: false });
    expect(res.job).toMatchObject({ statusCategory: "completed", sharedWithClient: true, approvedAt: fakeClock.now(), deliveredAt: fakeClock.now(), completedAt: fakeClock.now() });
    expect((await transitionsOf(job.id)).map((t) => t.toCategory)).toEqual(["submitted", "approved", "delivered", "completed"]);
    expect(await eventsOf(job.id, "job.status_changed")).toHaveLength(3);
    for (const type of ["job.approved", "job.delivered", "job.completed", "job.client_sharing_changed", "link.client_sharing_changed"]) {
      expect(await eventsOf(job.id, type), type).toHaveLength(1);
    }
    expect((await linksOf(job.id))[0].sharedWithClient).toBe(true);
    const clientNotices = await db.select().from(notifications).where(eq(notifications.userId, ids.users.client));
    expect(clientNotices.map((n) => n.type)).toEqual(["client_work_delivered"]);
    expect((await db.select().from(notifications).where(eq(notifications.type, "work_approved"))).map((n) => n.userId)).toEqual([ids.users.editor1]);
    await expectClean();
  });

  it("Approve & send without a link list shares the current finished link by default, never reference links; an empty list shares only the job", async () => {
    const { job, link } = await readyJob();
    const reference = await as("owner", (tx, ctx) => addLink(tx, ctx, { jobId: job.id, kind: "reference", url: "https://example.com/brief" }));
    const res = await act("owner", approveJob, job.id, { share: "send" });
    expect(res).toMatchObject({ stoppedAt: "completed", sharedWithClient: true });
    const rows = await linksOf(job.id);
    expect(rows.find((l) => l.id === link.id)?.sharedWithClient).toBe(true);
    expect(rows.find((l) => l.id === reference.id)?.sharedWithClient).toBe(false);
    const bare = await readyJob();
    const onlyJob = await act("owner", approveJob, bare.job.id, { share: "send", shareLinkIds: [] });
    expect(onlyJob.job.sharedWithClient).toBe(true);
    expect((await linksOf(bare.job.id))[0].sharedWithClient).toBe(false);
    await expectClean();
  });

  it("Approve only stops at Approved: Done · Not sent to client, nothing shared", async () => {
    const { job } = await readyJob();
    const res = await act("owner", approveJob, job.id, { share: "only" });
    expect(res.steps.map((s) => s.toStatus.category)).toEqual(["approved"]);
    expect(res).toMatchObject({ stoppedAt: "approved", notSentToClient: true, sharedWithClient: false });
    expect(res.stage).toMatchObject({ stage: "done", subLabel: "not_sent_to_client" });
    expect(res.job.sharedWithClient).toBe(false);
    expect(await db.select().from(notifications).where(eq(notifications.userId, ids.users.client))).toHaveLength(0);
    await expectClean();
  });

  it("n/a (the client has no portal) finishes straight away: Approved → Completed, two rows", async () => {
    const { job } = await readyJob();
    const res = await act("owner", approveJob, job.id, { share: "n/a" });
    expect(res.steps.map((s) => s.toStatus.category)).toEqual(["approved", "completed"]);
    expect(res).toMatchObject({ stoppedAt: "completed", notSentToClient: true, sharedWithClient: false });
    expect((await transitionsOf(job.id)).map((t) => t.toCategory)).toEqual(["submitted", "approved", "completed"]);
    await expectClean();
  });

  it("approveShareChoiceFor asks only when the job's client uses the portal", async () => {
    const portal = (await insertJobFixture(db, ids, { statusKey: "submitted" })).job;
    expect(await as("owner", (tx, ctx) => approveShareChoiceFor(tx, ctx, portal.id))).toBe("ask");
    await db.update(organisationSettings).set({ timezone: "Australia/Sydney" }); // no-op, keeps the row warm
    const { clients } = await import("@/db/schema");
    await db.update(clients).set({ portalEnabled: false }).where(eq(clients.id, ids.clientId2));
    const noPortal = (await insertJobFixture(db, ids, { statusKey: "submitted", projectId: ids.projectId2 })).job;
    expect(await as("owner", (tx, ctx) => approveShareChoiceFor(tx, ctx, noPortal.id))).toBe("n/a");
  });

  it("works from every Ready-to-check status (Review Required, Resubmitted) and is a 422 elsewhere", async () => {
    const review = (await readyJob("review")).job;
    expect((await act("owner", approveJob, review.id, { share: "only" })).stoppedAt).toBe("approved");
    const resubmitted = (await readyJob("resubmitted")).job;
    expect((await act("owner", approveJob, resubmitted.id, { share: "only" })).stoppedAt).toBe("approved");
    const editing = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job;
    expect((await catchErr(act("owner", approveJob, editing.id, { share: "only" }))).code).toBe("invalid_transition");
    expect((await catchErr(act("owner", approveJob, editing.id, { share: "maybe" }))).status).toBe(400);
    await expectClean();
  });

  it("a member checks their own shoots (decision 4) but never someone else's; editors never approve", async () => {
    const mine = (await insertJobFixture(db, ids, { statusKey: "submitted", photographerId: ids.users.photographer1 })).job;
    expect((await act("photographer1", approveJob, mine.id, { share: "n/a" })).stoppedAt).toBe("completed");
    const theirs = (await insertJobFixture(db, ids, { statusKey: "submitted", photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 })).job;
    expect((await catchErr(act("photographer1", approveJob, theirs.id, { share: "n/a" }))).status).toBe(404); // not even visible
    const assigned = (await insertJobFixture(db, ids, { statusKey: "submitted" })).job;
    expect((await catchErr(act("editor1", approveJob, assigned.id, { share: "n/a" }))).status).toBe(403);
    await expectClean();
  });

  describe("self-approval (decision 3)", () => {
    it("an owner / co-owner who edited the job must confirm; every event of the chain records selfApproved and the summary says so", async () => {
      // the co-owner did the edit themselves
      const { job } = await insertJobFixture(db, ids, { statusKey: "submitted", editorId: ids.users.coAdmin });
      const err = await catchErr(act("coAdmin", approveJob, job.id, { share: "n/a" }));
      expect(err.status).toBe(422);
      expect(err.message).toBe(SELF_APPROVAL_CONFIRM_MESSAGE);
      expect(err.details).toMatchObject({ fieldErrors: { confirmSelfApproval: ["Required"] } });
      expect((await jobRow(job.id)).statusCategory).toBe("submitted"); // nothing moved
      const res = await act("coAdmin", approveJob, job.id, { share: "n/a", confirmSelfApproval: true });
      expect(res.selfApproved).toBe(true);
      expect(res.steps.map((s) => s.toStatus.category)).toEqual(["approved", "completed"]);
      const statusEvents = await eventsOf(job.id, "job.status_changed");
      expect(statusEvents).toHaveLength(2);
      for (const e of statusEvents) expect(e.metadata.selfApproved).toBe(true);
      const approved = (await eventsOf(job.id, "job.approved"))[0];
      expect(approved.metadata.selfApproved).toBe(true);
      expect(approved.summary).toBe("approved the work they edited themselves");
      expect((await eventsOf(job.id, "job.completed"))[0].metadata.selfApproved).toBe(true);
      await expectClean();
    });

    it("the owner who never touched the edit needs no confirm and nothing is flagged", async () => {
      const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
      const res = await act("owner", approveJob, job.id, { share: "n/a" });
      expect(res.selfApproved).toBe(false);
      for (const e of await eventsOf(job.id, "job.status_changed")) expect(e.metadata.selfApproved).toBeUndefined();
    });

    it("editors and non-admin photographers who edited the job stay blocked (403), confirm or not", async () => {
      // photographer1 edited her own shoot earlier (past editor), now manages it with Review submissions
      const { job } = await insertJobFixture(db, ids, { statusKey: "submitted", photographerId: ids.users.photographer1, editorId: ids.users.photographer1 });
      const err = await catchErr(act("photographer1", approveJob, job.id, { share: "n/a", confirmSelfApproval: true }));
      expect(err.status).toBe(403);
      expect(err.message).toMatch(/your own edit/);
      const editorJob = (await insertJobFixture(db, ids, { statusKey: "submitted" })).job;
      expect((await catchErr(act("editor1", approveJob, editorJob.id, { share: "n/a", confirmSelfApproval: true }))).status).toBe(403);
      expect((await jobRow(job.id)).statusCategory).toBe("submitted");
    });
  });

  it("stops at the furthest reachable step on a custom workflow without a Delivered status (never adds steps): & send delivers through Complete", async () => {
    // "Quick Turnaround": the default graph with `delivered` archived; a job type bound to it.
    const quick = await insertDefaultWorkflow(db, ids.organisationId, { idPrefix: "quick", name: "Quick Turnaround", isDefault: false, createdByUserId: ids.users.owner });
    await db.update(workflowStatuses).set({ archivedAt: fakeClock.now() }).where(eq(workflowStatuses.id, quick.statuses.delivered));
    const [jt] = await db
      .insert(jobTypes)
      .values({ organisationId: ids.organisationId, name: "Quick retouch", workflowId: quick.workflowId, sortOrder: 99 })
      .returning();
    const created = await as("owner", (tx, ctx) => createJob(tx, ctx, { name: "Hero retouch", projectId: ids.projectId, jobTypeId: jt.id, editorId: ids.users.editor1 }));
    const jobId = created.job.id;
    await act("editor1", startJob, jobId);
    await act("editor1", sendForChecking, jobId, { finishedLink: { url: FINISHED } });
    const res = await act("owner", approveJob, jobId, { share: "send" });
    expect(res.steps.map((s) => s.toStatus.category)).toEqual(["approved", "completed"]);
    expect(res).toMatchObject({ stoppedAt: "completed", sharedWithClient: true, notSentToClient: false });
    expect(res.job).toMatchObject({ sharedWithClient: true, deliveredAt: null, completedAt: fakeClock.now() });
    expect(res.steps[1].delivery?.jobShared).toBe(true);
    // no status was invented: every row points at a status of the quick workflow
    const rows = await transitionsOf(jobId);
    expect(rows.every((t) => Object.values(quick.statuses).includes(t.toStatusId))).toBe(true);
    expect(rows.map((t) => t.toCategory)).toEqual(["new", "assigned", "in_progress", "submitted", "approved", "completed"]);
    await expectClean();
  });

  it("stops at Approved on a workflow with neither Delivered nor Completed reachable", async () => {
    const quick = await insertDefaultWorkflow(db, ids.organisationId, { idPrefix: "dead", name: "Dead end", isDefault: false, createdByUserId: ids.users.owner });
    const { workflowTransitions } = await import("@/db/schema");
    await db.update(workflowStatuses).set({ archivedAt: fakeClock.now() }).where(eq(workflowStatuses.id, quick.statuses.delivered));
    await db.update(workflowTransitions).set({ archivedAt: fakeClock.now() }).where(eq(workflowTransitions.id, quick.transitions["approved->completed"]));
    const [jt] = await db.insert(jobTypes).values({ organisationId: ids.organisationId, name: "Dead end type", workflowId: quick.workflowId, sortOrder: 98 }).returning();
    const created = await as("owner", (tx, ctx) => createJob(tx, ctx, { name: "Stuck", projectId: ids.projectId, jobTypeId: jt.id, editorId: ids.users.editor1 }));
    await act("editor1", sendForChecking, created.job.id, { finishedLink: { url: FINISHED } });
    const res = await act("owner", approveJob, created.job.id, { share: "send" });
    expect(res.steps.map((s) => s.toStatus.category)).toEqual(["approved"]);
    expect(res).toMatchObject({ stoppedAt: "approved", sharedWithClient: false });
    expect(res.stage).toMatchObject({ stage: "done", subLabel: "not_sent_to_client" });
    await expectClean();
  });
});

/* ------------------------------------------------------------------ */
/*  Ask for changes                                                    */
/* ------------------------------------------------------------------ */

describe("askForChanges", () => {
  it("one required box → a revision with reason 'Changes', the note as description, the current editor, needed back tomorrow (org timezone)", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    expect((await catchErr(act("owner", askForChanges, job.id, { note: "  " }))).status).toBe(400);
    const res = await act("owner", askForChanges, job.id, { note: "The kitchen reads too warm." });
    expect(res.stage).toMatchObject({ stage: "changes_asked", waitingOn: "editor" });
    expect(res.revision).toMatchObject({
      revisionNumber: 1,
      reason: "Changes",
      description: "The kitchen reads too warm.",
      assigneeUserId: ids.users.editor1,
      dueDate: "2026-10-09T12:59:59.999Z", // tomorrow, end of the civil day in Sydney
      requestedByUserId: ids.users.owner,
    });
    expect(res.job).toMatchObject({ statusCategory: "revision", revisionCount: 1, openRevisionId: res.revision.id });
    expect((await db.select().from(notifications).where(eq(notifications.type, "revision_requested"))).map((n) => n.userId)).toEqual([ids.users.editor1]);
    await expectClean();
  });

  it("chips become the reason (joined, de-duplicated) and 'Needed back by' can be changed", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "resubmitted" });
    const res = await act("owner", askForChanges, job.id, { note: "Sky and the bins please.", chips: ["Sky", "Remove items", "Sky"], neededBy: "2026-10-12" });
    expect(res.revision).toMatchObject({ reason: "Sky, Remove items", dueDate: "2026-10-12T12:59:59.999Z" });
    expect(res.stage.stage).toBe("changes_asked");
    await expectClean();
  });

  it("members ask for changes on their own shoots only; a job that is not ready to check is a 422", async () => {
    const theirs = (await insertJobFixture(db, ids, { statusKey: "submitted", photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 })).job;
    expect((await catchErr(act("photographer1", askForChanges, theirs.id, { note: "x" }))).status).toBe(404);
    const editing = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job;
    expect((await catchErr(act("owner", askForChanges, editing.id, { note: "x" }))).code).toBe("invalid_transition");
  });
});

/* ------------------------------------------------------------------ */
/*  Reopen                                                             */
/* ------------------------------------------------------------------ */

describe("reopenJobSimple", () => {
  it("'Client wants changes' on a Completed job: a recorded reopen into Changes asked with a revision for the editor", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "completed" });
    const res = await act("owner", reopenJobSimple, job.id, { reason: "client_changes", note: "The vendor wants the pool shot brighter." });
    expect(res.stage.stage).toBe("changes_asked");
    expect(res.transition).toMatchObject({ isReopen: true });
    expect(res.job).toMatchObject({ statusCategory: "revision", reopenedCount: 1, completedAt: null, revisionCount: 1 });
    const revision = await first(db.select().from(jobRevisions).where(eq(jobRevisions.jobId, job.id)));
    expect(revision).toMatchObject({ reason: "Client wants changes", description: "The vendor wants the pool shot brighter.", assigneeUserId: ids.users.editor1 });
    expect(await eventsOf(job.id, "job.reopened")).toHaveLength(1);
    await expectClean();
  });

  it("'Client wants changes' on an Approved (not sent) job goes back through the normal Changes asked edge", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "approved" });
    const res = await act("owner", reopenJobSimple, job.id, { reason: "client_changes" });
    expect(res.job.statusCategory).toBe("revision");
    expect(res.transition?.isReopen).toBe(false);
    expect((await first(db.select().from(jobRevisions).where(eq(jobRevisions.jobId, job.id))))?.description).toBe("Client wants changes");
    await expectClean();
  });

  it("'Fix the delivery link' keeps the job Done and records the new client-visible link, superseding the old one", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    const finished = await as("owner", (tx, ctx) => addLink(tx, ctx, { jobId: job.id, kind: "finished_files", url: FINISHED }));
    await act("owner", approveJob, job.id, { share: "send", shareLinkIds: [finished.id] });
    const before = await jobRow(job.id);
    expect((await catchErr(act("owner", reopenJobSimple, job.id, { reason: "fix_delivery_link" }))).status).toBe(400); // link required
    const res = await act("owner", reopenJobSimple, job.id, { reason: "fix_delivery_link", newLink: { url: FINISHED_V2, label: "Corrected download" } });
    expect(res.transition).toBeNull();
    expect(res.job).toMatchObject({ statusCategory: "completed", version: before.version }); // untouched
    expect(res.stage.stage).toBe("done");
    expect(res.link).toMatchObject({ url: FINISHED_V2, label: "Corrected download", sharedWithClient: true, supersedesLinkId: finished.id });
    const rows = await linksOf(job.id);
    expect(rows.find((l) => l.id === finished.id)?.supersededByLinkId).toBe(res.link?.id);
    expect(await eventsOf(job.id, "link.replaced")).toHaveLength(1);
    expect((await transitionsOf(job.id)).length).toBe(4); // no status row added
    await expectClean();
  });

  it("only Done jobs reopen; the reason must be one of the two", async () => {
    const editing = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job;
    expect((await catchErr(act("owner", reopenJobSimple, editing.id, { reason: "client_changes" }))).code).toBe("invalid_transition");
    const done = (await insertJobFixture(db, ids, { statusKey: "completed" })).job;
    expect((await catchErr(act("owner", reopenJobSimple, done.id, { reason: "whatever" }))).status).toBe(400);
    expect((await catchErr(act("editor1", reopenJobSimple, done.id, { reason: "client_changes" }))).status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/*  Cancel / restore                                                   */
/* ------------------------------------------------------------------ */

describe("cancelJobSimple / restoreJobSimple", () => {
  it("cancel needs a reason and shows as Cancelled; restore brings the job back to the stage it left", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    expect((await catchErr(act("owner", cancelJobSimple, job.id, {}))).status).toBe(400);
    const cancelled = await act("owner", cancelJobSimple, job.id, { reason: "Listing withdrawn by the vendor" });
    expect(cancelled.stage).toMatchObject({ stage: "cancelled", active: false });
    const restored = await act("owner", restoreJobSimple, job.id, {});
    expect(restored.stage.stage).toBe("with_editor");
    expect(restored.job.statusCategory).toBe("in_progress");
    await expectClean();
  });
});

/* ------------------------------------------------------------------ */
/*  createJob: silent projects, default due date, stage                */
/* ------------------------------------------------------------------ */

describe("createJob (simplified form)", () => {
  it("autoProject reuses the client's project when the address matches its name case- and space-insensitively", async () => {
    const res = await as("owner", (tx, ctx) =>
      createJob(tx, ctx, { name: "123 Smith Street · Listing photos", autoProject: { clientId: ids.clientId, address: "  123   smith STREET " }, jobTypeId: ids.defaultJobTypeId }),
    );
    expect(res.job.projectId).toBe(ids.projectId);
    expect(res.autoProject).toEqual({ projectId: ids.projectId, reused: true });
    expect((await eventsOf(res.job.id, "job.created"))[0].metadata.autoProject).toEqual({ projectId: ids.projectId, reused: true });
    expect(await db.select().from(projects).where(eq(projects.organisationId, ids.organisationId))).toHaveLength(2);
    // the project's address matches too
    const byAddress = await as("owner", (tx, ctx) =>
      createJob(tx, ctx, { name: "Floor plan", autoProject: { clientId: ids.clientId, address: "123 Smith Street, Bondi NSW" }, jobTypeId: ids.defaultJobTypeId }),
    );
    expect(byAddress.job.projectId).toBe(ids.projectId);
    await expectClean();
  });

  it("autoProject creates the project from the address when nothing matches (name = address = the typed address), once", async () => {
    const first1 = await as("photographer1", (tx, ctx) =>
      createJob(tx, ctx, { name: "Listing photos", autoProject: { clientId: ids.clientId, address: "7/22 Campbell Parade, Bondi Beach" }, jobTypeId: ids.defaultJobTypeId }),
    );
    expect(first1.autoProject?.reused).toBe(false);
    const project = await first(db.select().from(projects).where(eq(projects.id, first1.job.projectId)));
    expect(project).toMatchObject({ name: "7/22 Campbell Parade, Bondi Beach", address: "7/22 Campbell Parade, Bondi Beach", clientId: ids.clientId, createdByUserId: ids.users.photographer1 });
    const second = await as("owner", (tx, ctx) =>
      createJob(tx, ctx, { name: "Twilight", autoProject: { clientId: ids.clientId, address: "7/22 campbell parade, bondi beach" }, jobTypeId: ids.defaultJobTypeId }),
    );
    expect(second.job.projectId).toBe(first1.job.projectId);
    expect(second.autoProject?.reused).toBe(true);
    // another client with the same address gets its own project
    const other = await as("owner", (tx, ctx) =>
      createJob(tx, ctx, { name: "Listing photos", autoProject: { clientId: ids.clientId2, address: "7/22 Campbell Parade, Bondi Beach" }, jobTypeId: ids.defaultJobTypeId }),
    );
    expect(other.job.projectId).not.toBe(first1.job.projectId);
    expect(other.job.clientId).toBe(ids.clientId2);
    // exactly one of projectId / newProject / autoProject
    expect(
      (await catchErr(as("owner", (tx, ctx) => createJob(tx, ctx, { name: "x", projectId: ids.projectId, autoProject: { clientId: ids.clientId, address: "y" }, jobTypeId: ids.defaultJobTypeId }))))
        .status,
    ).toBe(400);
    await expectClean();
  });

  it("due date defaults to shoot date + the type's usual days to edit (1 when unset); an explicit value or null wins", async () => {
    const base = { name: "Due default", autoProject: { clientId: ids.clientId, address: "1 Test Street" }, jobTypeId: ids.defaultJobTypeId };
    const a = await as("owner", (tx, ctx) => createJob(tx, ctx, { ...base, shootDate: "2026-10-08" }));
    expect(a.job.dueDate).toBe("2026-10-09T12:59:59.999Z");
    const jt = await first(db.select().from(jobTypes).where(eq(jobTypes.id, ids.defaultJobTypeId)));
    await as("owner", (tx, ctx) => setJobTypeUsualDays(tx, ctx, { jobTypeId: ids.defaultJobTypeId, usualDaysToEdit: 3, expectedVersion: jt?.version }));
    const b = await as("owner", (tx, ctx) => createJob(tx, ctx, { ...base, shootDate: "2026-10-08" }));
    expect(b.job.dueDate).toBe("2026-10-11T12:59:59.999Z");
    const c = await as("owner", (tx, ctx) => createJob(tx, ctx, { ...base, shootDate: "2026-10-08", dueDate: null }));
    expect(c.job.dueDate).toBeNull();
    const d = await as("owner", (tx, ctx) => createJob(tx, ctx, { ...base, shootDate: "2026-10-08", dueDate: "2026-10-20" }));
    expect(d.job.dueDate).toBe("2026-10-20T12:59:59.999Z");
    const e = await as("owner", (tx, ctx) => createJob(tx, ctx, base)); // no shoot date → no default
    expect(e.job.dueDate).toBeNull();
    expect((await eventsOf(jt?.id ?? "", "job_type.updated")).length).toBe(0); // job_type events carry no jobId
    expect(await db.select().from(activityEvents).where(eq(activityEvents.eventType, "job_type.updated"))).toHaveLength(1);
    await expectClean();
  });

  it("the result carries the stage: Needs editor, or With editor when 'Create & send to Sam'", async () => {
    const later = await as("owner", (tx, ctx) => createJob(tx, ctx, { name: "Decide later", projectId: ids.projectId, jobTypeId: ids.defaultJobTypeId }));
    expect(later.stage).toMatchObject({ stage: "needs_editor", waitingOn: "photographer" });
    const sent = await as("owner", (tx, ctx) => createJob(tx, ctx, { name: "To Sam", projectId: ids.projectId, jobTypeId: ids.defaultJobTypeId, editorId: ids.users.editor1 }));
    expect(sent.stage).toMatchObject({ stage: "with_editor", subLabel: "not_started" });
    // an editor creating a job gets the org owner as photographer (unchanged behaviour)
    const byEditor = await as("editor1", (tx, ctx) => createJob(tx, ctx, { name: "Editor made", projectId: ids.projectId, jobTypeId: ids.defaultJobTypeId }));
    expect(byEditor.job.photographerId).toBe(ids.users.owner);
    expect(byEditor.stage.stage).toBe("needs_editor");
    await expectClean();
  });
});

/* ------------------------------------------------------------------ */
/*  Notifications: defaults, mark old updates read                     */
/* ------------------------------------------------------------------ */

describe("notification defaults (plan §8)", () => {
  it("exactly the 8 default groups (12 staff types) are on without a preference row; everything else is off; an explicit row wins", async () => {
    expect([...DEFAULT_ON_NOTIFICATION_TYPES].sort()).toEqual(
      [
        "job_assigned",
        "work_submitted",
        "work_resubmitted",
        "revision_requested",
        "work_approved",
        "comment_added",
        "mentioned",
        "client_feedback",
        "job_overdue",
        "job_unassigned",
        "job_reassigned",
        "job_cancelled",
      ].sort(),
    );
    expect(DEFAULT_OFF_NOTIFICATION_TYPES).toHaveLength(11);
    const send = (type: (typeof DEFAULT_OFF_NOTIFICATION_TYPES)[number] | "work_approved") =>
      as("coAdmin", (tx, ctx) => notify(tx, ctx, { userIds: [ids.users.editor1, ids.users.editor2], type, title: type, linkPath: "/jobs" }));
    expect((await send("work_approved")).recipientIds.sort()).toEqual([ids.users.editor1, ids.users.editor2].sort());
    expect((await send("job_completed")).recipientIds).toEqual([]);
    await db.insert(userNotificationPrefs).values({ organisationId: ids.organisationId, userId: ids.users.editor1, type: "job_completed", enabled: true });
    await db.insert(userNotificationPrefs).values({ organisationId: ids.organisationId, userId: ids.users.editor2, type: "work_approved", enabled: false });
    expect((await send("job_completed")).recipientIds).toEqual([ids.users.editor1]);
    expect((await send("work_approved")).recipientIds).toEqual([ids.users.editor1]);
  });

  it("markOldUpdatesRead marks only the actor's unread notices of the now-hidden types", async () => {
    const at = fakeClock.now();
    const row = (userId: string, type: "job_completed" | "deadline_changed" | "work_approved", readAt: string | null = null) => ({
      organisationId: ids.organisationId,
      userId,
      type,
      title: type,
      linkPath: "/jobs",
      createdAt: at,
      readAt,
    });
    await db.insert(notifications).values([
      row(ids.users.editor1, "job_completed"),
      row(ids.users.editor1, "deadline_changed"),
      row(ids.users.editor1, "work_approved"),
      row(ids.users.editor1, "job_completed", at),
      row(ids.users.editor2, "job_completed"),
    ]);
    expect(await as("editor1", (tx, ctx) => markOldUpdatesRead(tx, ctx))).toEqual({ updated: 2 });
    const mine = await db.select().from(notifications).where(eq(notifications.userId, ids.users.editor1));
    expect(mine.filter((n) => n.readAt === null).map((n) => n.type)).toEqual(["work_approved"]);
    expect((await db.select().from(notifications).where(eq(notifications.userId, ids.users.editor2)))[0].readAt).toBeNull();
    expect(await as("editor1", (tx, ctx) => markOldUpdatesRead(tx, ctx))).toEqual({ updated: 0 });
  });

  it("dismissSimplerNotice stamps the card as dismissed once, audited", async () => {
    const res = await as("editor1", (tx, ctx) => dismissSimplerNotice(tx, ctx));
    expect(res.simplerNoticeDismissedAt).toBe(fakeClock.now());
    fakeClock.advanceHours(1);
    const again = await as("editor1", (tx, ctx) => dismissSimplerNotice(tx, ctx));
    expect(again.simplerNoticeDismissedAt).toBe(T0);
    const events = await db.select().from(activityEvents).where(and(eq(activityEvents.entityId, ids.users.editor1), eq(activityEvents.eventType, "user.updated")));
    expect(events).toHaveLength(1);
    expect(events[0].newValue).toEqual({ simplerNoticeDismissedAt: T0 });
  });
});

/* ------------------------------------------------------------------ */
/*  Settings: Advanced tools, usual capacity, usual days, close delivered */
/* ------------------------------------------------------------------ */

describe("setAdvancedTools / setEditorUsualCapacity / setJobTypeUsualDays / closeDeliveredJobs", () => {
  it("Advanced tools is off by default; the owner turns it on (audited settings.updated) and the context carries it; members cannot", async () => {
    expect((await ctxOf("owner")).settings.advancedToolsEnabled).toBe(false);
    const res = await as("owner", (tx, ctx) => setAdvancedTools(tx, ctx, { enabled: true }));
    expect(res).toMatchObject({ enabled: true, changed: true });
    expect((await ctxOf("owner")).settings.advancedToolsEnabled).toBe(true);
    expect((await ctxOf("editor1")).settings.advancedToolsEnabled).toBe(true);
    const events = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "settings.updated"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ visibility: "management", previousValue: { field: "advancedToolsEnabled", value: false }, newValue: { field: "advancedToolsEnabled", value: true } });
    expect((await as("owner", (tx, ctx) => setAdvancedTools(tx, ctx, { enabled: true }))).changed).toBe(false);
    expect((await catchErr(as("lead", (tx, ctx) => setAdvancedTools(tx, ctx, { enabled: false })))).status).toBe(403);
    expect((await catchErr(as("owner", (tx, ctx) => setAdvancedTools(tx, ctx, { enabled: "yes" })))).status).toBe(400);
  });

  it("'Usually handles up to N': editors only, admin only, audited; null clears", async () => {
    const editor = await first(db.select().from(users).where(eq(users.id, ids.users.editor1)));
    const res = await as("owner", (tx, ctx) => setEditorUsualCapacity(tx, ctx, { userId: ids.users.editor1, usualCapacityJobs: 6, expectedVersion: editor?.version }));
    expect(res.usualCapacityJobs).toBe(6);
    const evt = await db.select().from(activityEvents).where(and(eq(activityEvents.eventType, "user.capacity_changed"), eq(activityEvents.entityId, ids.users.editor1)));
    expect(evt).toHaveLength(1);
    expect(evt[0].newValue).toMatchObject({ usualCapacityJobs: 6 });
    expect((await as("owner", (tx, ctx) => setEditorUsualCapacity(tx, ctx, { userId: ids.users.editor1, usualCapacityJobs: null }))).usualCapacityJobs).toBeNull();
    expect((await catchErr(as("owner", (tx, ctx) => setEditorUsualCapacity(tx, ctx, { userId: ids.users.photographer1, usualCapacityJobs: 3 })))).status).toBe(422);
    expect((await catchErr(as("lead", (tx, ctx) => setEditorUsualCapacity(tx, ctx, { userId: ids.users.editor1, usualCapacityJobs: 3 })))).status).toBe(403);
    expect((await catchErr(as("owner", (tx, ctx) => setEditorUsualCapacity(tx, ctx, { userId: ids.users.editor1, usualCapacityJobs: 0 })))).status).toBe(400);
  });

  it("'Close delivered jobs': every Approved / Delivered job is completed one by one through the engine; others untouched; admin only", async () => {
    const approved = (await insertJobFixture(db, ids, { statusKey: "approved" })).job;
    const delivered = (await insertJobFixture(db, ids, { statusKey: "delivered" })).job;
    const editing = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job;
    expect((await catchErr(as("lead", (tx, ctx) => closeDeliveredJobs(tx, ctx, { confirm: true })))).status).toBe(403);
    expect((await catchErr(as("owner", (tx, ctx) => closeDeliveredJobs(tx, ctx, {})))).status).toBe(400);
    const res = await as("owner", (tx, ctx) => closeDeliveredJobs(tx, ctx, { confirm: true }));
    expect(res.ok.sort()).toEqual([approved.id, delivered.id].sort());
    expect(res.failed).toEqual([]);
    expect((await jobRow(approved.id)).statusCategory).toBe("completed");
    expect((await jobRow(delivered.id)).statusCategory).toBe("completed");
    expect((await jobRow(editing.id)).statusCategory).toBe("in_progress");
    expect((await transitionsOf(approved.id)).map((t) => t.toCategory)).toEqual(["approved", "completed"]);
    expect(await eventsOf(approved.id, "job.completed")).toHaveLength(1);
    expect((await as("owner", (tx, ctx) => closeDeliveredJobs(tx, ctx, { confirm: true }))).ok).toEqual([]);
    await expectClean();
  });
});

/* ------------------------------------------------------------------ */
/*  Invite presets (plan §2, decision 4)                               */
/* ------------------------------------------------------------------ */

describe("inviteUser presets", () => {
  it("'Only their own shoots' sets create / assign / review on and the rest off; 'Everything (co-owner)' is an admin; explicit switches win", async () => {
    const own = await as("owner", (tx, ctx) => inviteUser(tx, ctx, { email: "own@studio.test", name: "Own Shoots", role: "photographer", preset: "own_shoots" }));
    expect(own.user).toMatchObject({ isAdmin: false, canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: true, canViewAllJobs: false, canViewTeamWorkloads: false, canViewAnalytics: false });
    const co = await as("owner", (tx, ctx) => inviteUser(tx, ctx, { email: "co@studio.test", name: "Co Owner", role: "photographer", preset: "co_owner" }));
    expect(co.user.isAdmin).toBe(true);
    const custom = await as("owner", (tx, ctx) => inviteUser(tx, ctx, { email: "custom@studio.test", name: "Custom", role: "photographer", preset: "own_shoots", flags: { canViewAllJobs: true } }));
    expect(custom.user).toMatchObject({ isAdmin: false, canViewAllJobs: true, canReviewSubmissions: true });
    const created = await db.select().from(activityEvents).where(and(eq(activityEvents.eventType, "user.created"), eq(activityEvents.entityId, own.user.id)));
    expect(created[0].metadata.preset).toBe("own_shoots");
    const editor = await as("owner", (tx, ctx) => inviteUser(tx, ctx, { email: "ed@studio.test", name: "Ed", role: "editor", usualCapacityJobs: 5 }));
    expect(editor.user.usualCapacityJobs).toBe(5);
    expect((await catchErr(as("owner", (tx, ctx) => inviteUser(tx, ctx, { email: "x@studio.test", name: "X", role: "editor", preset: "own_shoots" })))).status).toBe(400);
    // the member without Review submissions still cannot approve anything (nothing changed for existing people)
    await setUserFlags(db, ids.users.photographer2, { canReviewSubmissions: false });
    const job = (await insertJobFixture(db, ids, { statusKey: "submitted", photographerId: ids.users.photographer2 })).job;
    expect((await catchErr(act("photographer2", approveJob, job.id, { share: "n/a" }))).status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/*  Stale page vs permission (reviewer finding E2)                     */
/* ------------------------------------------------------------------ */

describe("stale page vs permission on the simple actions (E2)", () => {
  it("a PAST editor from a stale page gets 409 (the job moved to someone else); fresh → the plain 403; the current editor stale → 409; strangers 403 / 404", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    await act("editor1", sendForChecking, job.id, { finishedLink: { url: FINISHED } });
    const sent = await jobRow(job.id);
    // Eve's tab still shows Send for checking / Can't do this one; meanwhile the owner asks for changes and moves the round to Ed.
    await act("owner", askForChanges, job.id, { note: "Sky too dark" });
    const swapped = await act("owner", changeEditor, job.id, { editorId: ids.users.editor2 });
    expect(swapped.job.editorId).toBe(ids.users.editor2);
    const staleSend = await catchErr(as("editor1", (tx, ctx) => sendForChecking(tx, ctx, { jobId: job.id, expectedVersion: sent.version, finishedLink: { url: FINISHED_V2 } })));
    expect([staleSend.status, staleSend.code]).toEqual([409, "conflict"]);
    expect((staleSend.details as { current: Job }).current).toMatchObject({ id: job.id, editorId: ids.users.editor2, version: swapped.job.version });
    const staleDecline = await catchErr(as("editor1", (tx, ctx) => declineJobSimple(tx, ctx, { jobId: job.id, expectedVersion: sent.version, reason: "Away" })));
    expect(staleDecline.status).toBe(409);
    // Fresh version, no longer the editor: 403 with the plain message.
    const fresh = await catchErr(as("editor1", (tx, ctx) => sendForChecking(tx, ctx, { jobId: job.id, expectedVersion: swapped.job.version, finishedLink: { url: FINISHED_V2 } })));
    expect([fresh.status, fresh.code, fresh.message]).toEqual([403, "forbidden", "This job is now with another editor. Nothing to do here."]);
    // The current editor on a stale page: 409 as always.
    expect((await catchErr(as("editor2", (tx, ctx) => sendForChecking(tx, ctx, { jobId: job.id, expectedVersion: 999, finishedLink: { url: FINISHED_V2 } })))).status).toBe(409);
    expect((await catchErr(as("editor2", (tx, ctx) => declineJobSimple(tx, ctx, { jobId: job.id, expectedVersion: 999, reason: "Away" })))).status).toBe(409);
    // Strangers: an editor who never held it cannot even see it (404); with ⚑see other editors' jobs it is a 403 before any version check.
    const other = (await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 })).job;
    expect((await catchErr(as("editor2", (tx, ctx) => sendForChecking(tx, ctx, { jobId: other.id, expectedVersion: 999, finishedLink: { url: FINISHED } })))).status).toBe(404);
    await setUserFlags(db, ids.users.editor2, { canViewTeamJobs: true });
    const stranger = await catchErr(as("editor2", (tx, ctx) => sendForChecking(tx, ctx, { jobId: other.id, expectedVersion: 999, finishedLink: { url: FINISHED } })));
    expect([stranger.status, stranger.message]).toEqual([403, "Only the assigned editor can do this"]);
    expect(JSON.stringify(stranger.details ?? null)).not.toContain("createdByUserId");
    expect((await catchErr(as("editor2", (tx, ctx) => declineJobSimple(tx, ctx, { jobId: other.id, expectedVersion: 999, reason: "x" })))).status).toBe(403);
    // Nothing moved.
    expect((await jobRow(job.id)).version).toBe(swapped.job.version);
    expect((await jobRow(other.id)).version).toBe(other.version);
    await expectClean();
  });

  it("the reviewer-side actions keep permission first for people who may not review, and a stale page 409 for those who may", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted", editorId: ids.users.editor1 });
    // The editor who did the work: never approves (403), stale or not, and never sees the row.
    const editor = await catchErr(as("editor1", (tx, ctx) => approveJob(tx, ctx, { jobId: job.id, expectedVersion: 999, share: "n/a" })));
    expect([editor.status, editor.code]).toEqual([403, "forbidden"]);
    expect(JSON.stringify(editor.details ?? null)).not.toContain("current");
    // The photographer of the job from a stale page: 409.
    expect((await catchErr(as("photographer1", (tx, ctx) => approveJob(tx, ctx, { jobId: job.id, expectedVersion: 999, share: "n/a" })))).status).toBe(409);
    expect((await catchErr(as("photographer1", (tx, ctx) => askForChanges(tx, ctx, { jobId: job.id, expectedVersion: 999, note: "x" })))).status).toBe(409);
    // A photographer who does not manage the job: 403, never the row.
    const other = await catchErr(as("photographer2", (tx, ctx) => approveJob(tx, ctx, { jobId: job.id, expectedVersion: 999, share: "n/a" })));
    expect(other.status).toBe(404); // not even visible without ⚑see all jobs
    await setUserFlags(db, ids.users.photographer2, { canViewAllJobs: true });
    const visible = await catchErr(as("photographer2", (tx, ctx) => approveJob(tx, ctx, { jobId: job.id, expectedVersion: 999, share: "n/a" })));
    expect([visible.status, visible.code]).toEqual([403, "forbidden"]);
    await expectClean();
  });
});
