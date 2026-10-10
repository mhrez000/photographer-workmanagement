/**
 * Roles v2 rules of the workflow engine (docs/ROLES.md §5.2, §3.4 self-review,
 * §7.3 delivery step): `actionsForMove` (every action must pass), the review
 * from-gate, the unassign defence in depth on every path (transition, kanban
 * drop, bulk), admin on-behalf, and the delivery step.
 */
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, jobLinks, jobs, notifications, users, workflowStatuses, workflowTransitions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, inviteDefaultsMember, makeTestDb, seedMinimalOrg, setUserFlags, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import type { AuthContext, Job } from "@/lib/types";
import { actionsForMove } from "@/lib/workflow";
import { kanbanDrop } from "@/server/actions/kanban";
import { AppError } from "@/server/errors";
import { withTx } from "./_shared";
import { assignEditor } from "./assignments";
import { bulkTransition, setPriority, updateJob } from "./jobs";
import { addLink } from "./links";
import { requestRevision, resolveRevision } from "./revisions";
import { addComment } from "./comments";
import { acceptJob, approveJob, completeJob, declineJob, deliverJob, getAllowedTransitions, reopenJob, restoreJob, startJob, submitJob, transitionJobStatus } from "./workflow";

let db: TestDb;
let ids: SeedIds;
const T0 = "2026-10-08T00:00:00.000Z";

beforeEach(async () => {
  fakeClock.set(T0);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const run = <T>(fn: (tx: Tx) => Promise<T> | T): Promise<T> => withTx(fn, { db });
async function asUser<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T>): Promise<T> {
  const ctx = await contextFor(db, userId);
  return run((tx) => fn(tx, ctx));
}
const as = <T>(actor: FixtureUserKey, fn: (tx: Tx, ctx: AuthContext) => Promise<T>) => asUser(ids.users[actor], fn);
async function jobRow(id: string): Promise<Job> {
  const row = await first(db.select().from(jobs).where(eq(jobs.id, id)));
  if (!row) throw new Error("job missing");
  return row;
}
async function moveAs(userId: string, jobId: string, input: Record<string, unknown>) {
  const expectedVersion = (await jobRow(jobId)).version;
  return asUser(userId, (tx, ctx) => transitionJobStatus(tx, ctx, { jobId, expectedVersion, ...input }));
}
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
const eventsOf = (jobId: string, type: string) =>
  db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.jobId, jobId), eq(activityEvents.eventType, type)))
    .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));

/** A photographer12-style member (invite defaults: create ✓, assign ✗ after this, review ✗). */
async function junior(): Promise<string> {
  const id = await inviteDefaultsMember(db, ids);
  await setUserFlags(db, id, { canAssignEditors: false });
  return id;
}

describe("actionsForMove (pure)", () => {
  const editor = { role: "editor" as const, userId: "e1" };
  const admin = { role: "photographer" as const, userId: "a1" };
  it("maps moves to every action that must pass", () => {
    expect(actionsForMove(admin, "approved", "delivered", false, { editorId: "e1" })).toEqual(["job.deliver", "job.begin_review"]);
    expect(actionsForMove(admin, "review", "approved", false, { editorId: "e1" })).toEqual(["job.approve", "job.begin_review"]);
    expect(actionsForMove(admin, "submitted", "review", false, { editorId: "e1" })).toEqual(["job.begin_review"]);
    expect(actionsForMove(admin, "in_progress", "ready", false, { editorId: "e1" })).toEqual(["job.assign_editor"]);
    expect(actionsForMove(admin, "review", "ready", false, { editorId: "e1" })).toEqual(["job.assign_editor", "job.begin_review"]);
    expect(actionsForMove(editor, "assigned", "ready", false, { editorId: "e1" })).toEqual(["job.decline"]);
    expect(actionsForMove(admin, "assigned", "ready", false, { editorId: "e1" })).toEqual(["job.assign_editor"]);
    expect(actionsForMove(admin, "ready", "new", false, { editorId: null })).toEqual(["job.transition"]);
    expect(actionsForMove(admin, "new", "assigned", false, { editorId: null })).toBeNull();
    expect(actionsForMove(admin, "completed", "in_progress", true, { editorId: "e1" })).toEqual(["job.reopen"]);
    expect(actionsForMove(admin, "review", "cancelled", false, { editorId: "e1" })).toEqual(["job.cancel", "job.begin_review"]);
    expect(actionsForMove(editor, "revision", "resubmitted", false, { editorId: "e1" })).toEqual(["revision.resolve"]);
  });
});

describe("edge roles + action rules", () => {
  it("an admin-only edge denies team members even on jobs they manage", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "ready", editorId: null });
    await db.update(workflowTransitions).set({ allowedRoles: ["admin"] }).where(eq(workflowTransitions.id, ids.transitions["ready->new"]));
    expect((await catchErr(moveAs(ids.users.photographer1, job.id, { toCategory: "new" }))).status).toBe(403);
    expect((await moveAs(ids.users.owner, job.id, { toCategory: "new" })).toStatus.category).toBe("new");
    await expectClean();
  });

  it("members without Review submissions cannot begin review / approve / deliver / complete / reopen; editors never approve", async () => {
    const member = await junior();
    const review = (await insertJobFixture(db, ids, { statusKey: "submitted", createdByUserId: member, photographerId: member })).job;
    for (const toCategory of ["review", "approved", "revision"] as const) {
      const err = await catchErr(moveAs(member, review.id, { toCategory, ...(toCategory === "revision" ? { revision: { reason: "x", description: "y" } } : {}) }));
      expect(err.status).toBe(403);
    }
    const approved = (await insertJobFixture(db, ids, { statusKey: "approved", createdByUserId: member, photographerId: member })).job;
    expect((await catchErr(moveAs(member, approved.id, { toCategory: "delivered" }))).status).toBe(403);
    expect((await catchErr(moveAs(member, approved.id, { toCategory: "completed" }))).status).toBe(403);
    const completed = (await insertJobFixture(db, ids, { statusKey: "completed", createdByUserId: member, photographerId: member })).job;
    expect((await catchErr(moveAs(member, completed.id, { toCategory: "in_progress", reason: "x" }))).status).toBe(403);
    // the member sees no review buttons at all
    const ctx = await contextFor(db, member);
    expect((await getAllowedTransitions(db, ctx, review.id)).transitions).toEqual([]);
    // editors never approve (no edge role, and job.approve is not an editor action)
    expect((await catchErr(moveAs(ids.users.editor1, review.id, { toCategory: "approved" }))).status).toBe(403);
    // the owner reviews it
    expect((await moveAs(ids.users.owner, review.id, { toCategory: "approved" })).toStatus.category).toBe("approved");
    await expectClean();
  });

  it("self-review: an admin who was an editor of the job cannot approve it (after a role change)", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" }); // editor1 did the edit
    await as("owner", (tx, ctx) => assignEditor(tx, ctx, { jobId: job.id, userId: ids.users.editor2, expectedVersion: job.version }));
    // editor1 becomes a photographer with admin (direct writes: role changes are package D's service)
    await db.update(users).set({ role: "photographer", isAdmin: true }).where(eq(users.id, ids.users.editor1));
    const err = await catchErr(moveAs(ids.users.editor1, job.id, { toCategory: "approved", override: false }));
    expect(err.status).toBe(403);
    // the owner, who never edited it, reviews it normally
    expect((await moveAs(ids.users.owner, job.id, { toCategory: "approved" })).toStatus.category).toBe("approved");
  });

  it("admins act on editor-side edges on behalf of the editor (metadata.onBehalfOf)", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    const res = await moveAs(ids.users.coAdmin, job.id, { toCategory: "accepted" });
    expect(res.toStatus.category).toBe("accepted");
    expect((await eventsOf(job.id, "job.status_changed"))[0].metadata.onBehalfOf).toBe(ids.users.editor1);
    // team members never act on editor-side edges
    const other = (await insertJobFixture(db, ids, { statusKey: "assigned" })).job;
    expect((await catchErr(moveAs(ids.users.photographer1, other.id, { toCategory: "accepted" }))).status).toBe(403);
  });
});

describe("unassigning through workflow moves needs job.assign_editor (every path)", () => {
  it("transition, kanban drop and bulk transition to ready are 403 for a member without Assign editors; the editor stays", async () => {
    const member = await junior();
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress", createdByUserId: member, photographerId: member });
    expect((await catchErr(moveAs(member, job.id, { toCategory: "ready" }))).status).toBe(403);
    const version = (await jobRow(job.id)).version;
    const drop = await catchErr(asUser(member, (tx, ctx) => kanbanDrop(tx, ctx, { jobId: job.id, column: "new", expectedVersion: version })));
    expect([403, 422]).toContain(drop.status);
    const bulk = await bulkTransition(await contextFor(db, member), { jobIds: [job.id], toCategory: "ready" }, { db });
    expect(bulk.ok).toEqual([]);
    expect(bulk.failed[0]?.code).toBe("forbidden");
    expect((await jobRow(job.id)).editorId).toBe(ids.users.editor1);
    // with the switch on the move is allowed (an unassignment)
    await setUserFlags(db, member, { canAssignEditors: true });
    expect((await moveAs(member, job.id, { toCategory: "ready" })).job.editorId).toBeNull();
    await expectClean();
  });

  it("a custom review → ready edge needs Review submissions too (the from-gate)", async () => {
    await db.insert(workflowTransitions).values({
      organisationId: ids.organisationId,
      workflowId: ids.workflowId,
      fromStatusId: ids.statuses.review,
      toStatusId: ids.statuses.ready,
      allowedRoles: ["photographer"],
    });
    const { job } = await insertJobFixture(db, ids, { statusKey: "review" });
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: false });
    expect((await catchErr(moveAs(ids.users.photographer1, job.id, { toCategory: "ready" }))).status).toBe(403);
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: true });
    expect((await moveAs(ids.users.photographer1, job.id, { toCategory: "ready" })).job.editorId).toBeNull();
    await expectClean();
  });

  it("an extra status in a review-gated category inherits the review gate for lateral moves", async () => {
    await db.insert(workflowStatuses).values({
      id: "studio-st-review2",
      organisationId: ids.organisationId,
      workflowId: ids.workflowId,
      key: "review2",
      name: "Second look",
      category: "review",
      sortOrder: 99,
      isInitial: false,
    });
    const { job } = await insertJobFixture(db, ids, { statusKey: "review" });
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: false });
    expect((await catchErr(moveAs(ids.users.photographer1, job.id, { toStatusId: "studio-st-review2" }))).status).toBe(403);
  });
});

describe("delivery step (§7.3)", () => {
  async function approvedJob(opts: { shared?: boolean } = {}) {
    const { job } = await insertJobFixture(db, ids, { statusKey: "approved", createdByUserId: ids.users.owner, photographerId: ids.users.owner, sharedWithClient: opts.shared ?? false });
    const ownerGallery = await as("owner", (tx, ctx) => addLink(tx, ctx, { jobId: job.id, kind: "gallery", url: "https://studio.pixieset.com/owner" }));
    const finished = await as("owner", (tx, ctx) => addLink(tx, ctx, { jobId: job.id, kind: "finished_files", url: "https://drive.google.com/final" }));
    return { job: await jobRow(job.id), ownerGallery, finished };
  }
  const linkRow = async (id: string) => first(db.select().from(jobLinks).where(eq(jobLinks.id, id)));

  it("a client-visible job: the default set = current gallery / client_delivery links added by a sharer; client told once", async () => {
    const { job, ownerGallery, finished } = await approvedJob({ shared: true });
    // an editor-added gallery link (added_by_sharer = false) is NOT in the default set
    const editorGallery = await first(
      db
        .insert(jobLinks)
        .values({ organisationId: ids.organisationId, jobId: job.id, kind: "gallery", url: "https://studio.pixieset.com/editor", addedByUserId: ids.users.editor1, addedBySharer: false, createdAt: T0 })
        .returning(),
    );
    const res = await as("owner", (tx, ctx) => deliverJob(tx, ctx, { jobId: job.id, expectedVersion: job.version }));
    expect(res.delivery).toMatchObject({ clientVisible: true, sharedLinkIds: [ownerGallery.id], jobShared: false });
    expect((await linkRow(ownerGallery.id))?.sharedWithClient).toBe(true);
    expect((await linkRow(finished.id))?.sharedWithClient).toBe(false);
    expect((await linkRow(editorGallery?.id ?? ""))?.sharedWithClient).toBe(false);
    const linkEvents = await eventsOf(job.id, "link.client_sharing_changed");
    expect(linkEvents.map((e) => e.metadata.reason)).toEqual(["delivered"]);
    const sent = await db.select().from(notifications).where(eq(notifications.type, "client_work_delivered"));
    expect(sent.map((n) => n.userId)).toEqual([ids.users.client]);
    expect(sent[0]?.dedupeKey).toMatch(new RegExp(`^client_delivered:${job.id}:`));
    await expectClean();
  });

  it("shareJob + explicit shareLinkIds (any current link) from the Deliver dialog; links stay shared after reopen", async () => {
    const { job, finished, ownerGallery } = await approvedJob();
    const res = await as("owner", (tx, ctx) => deliverJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, delivery: { shareJob: true, shareLinkIds: [finished.id] } }));
    expect(res.delivery).toMatchObject({ jobShared: true, sharedLinkIds: [finished.id], visibleLinkCount: 1 });
    expect(res.job.sharedWithClient).toBe(true);
    expect((await linkRow(ownerGallery.id))?.sharedWithClient).toBe(false);
    expect((await eventsOf(job.id, "job.client_sharing_changed"))[0].metadata.reason).toBe("delivered");
    const done = await as("owner", (tx, ctx) => completeJob(tx, ctx, { jobId: job.id, expectedVersion: res.job.version }));
    await as("owner", (tx, ctx) => reopenJob(tx, ctx, { jobId: job.id, expectedVersion: done.job.version, reason: "Fix one image", toCategory: "approved" }));
    expect((await linkRow(finished.id))?.sharedWithClient).toBe(true);
    await expectClean();
  });

  it("not shared: nothing is published; explicit link ids → 422; delivery on a non-delivering move → 422", async () => {
    const { job, ownerGallery } = await approvedJob();
    expect((await catchErr(as("owner", (tx, ctx) => deliverJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, delivery: { shareLinkIds: [ownerGallery.id] } })))).status).toBe(400);
    const res = await as("owner", (tx, ctx) => deliverJob(tx, ctx, { jobId: job.id, expectedVersion: job.version }));
    expect(res.delivery).toMatchObject({ clientVisible: false, sharedLinkIds: [] });
    expect(await db.select().from(notifications).where(eq(notifications.type, "client_work_delivered"))).toEqual([]);
    const other = (await insertJobFixture(db, ids, { statusKey: "submitted", createdByUserId: ids.users.owner })).job;
    expect((await catchErr(as("owner", (tx, ctx) => approveJob(tx, ctx, { jobId: other.id, expectedVersion: other.version, delivery: { shareJob: true } })))).status).toBe(422);
  });

  it("a client-visible job delivered with no visible link warns; a stranger's link id → 400", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "approved", createdByUserId: ids.users.owner, sharedWithClient: true });
    const foreign = await approvedJob();
    expect((await catchErr(as("owner", (tx, ctx) => deliverJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, delivery: { shareLinkIds: [foreign.finished.id] } })))).status).toBe(400);
    const res = await as("owner", (tx, ctx) => deliverJob(tx, ctx, { jobId: job.id, expectedVersion: job.version }));
    expect(res.warnings).toContain("The client will see Delivered with nothing to open");
  });

  it("complete without a prior delivery is a delivering move; the delivering member needs Review submissions to share", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "approved", createdByUserId: ids.users.photographer1, sharedWithClient: true });
    const res = await as("photographer1", (tx, ctx) => completeJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, delivery: { shareLinkIds: [] } }));
    expect(res.delivery).toMatchObject({ clientVisible: true, sharedLinkIds: [] });
    expect((await db.select().from(notifications).where(eq(notifications.type, "client_work_delivered"))).map((n) => n.userId)).toEqual([ids.users.client]);
  });
});

describe("turn client feedback into a revision request (§7.5)", () => {
  it("revision.requested carries fromFeedbackCommentId; needs client_feedback.to_revision", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "delivered", createdByUserId: ids.users.owner, sharedWithClient: true });
    const feedback = await as("client", (tx, ctx) => addComment(tx, ctx, { jobId: job.id, kind: "client_feedback", body: "Warmer please" }));
    const res = await as("owner", (tx, ctx) =>
      requestRevision(tx, ctx, { jobId: job.id, expectedVersion: job.version, reason: "Client feedback", description: "Warmer please", fromFeedbackCommentId: feedback.comment.id }),
    );
    const evt = (await eventsOf(job.id, "revision.requested"))[0];
    expect(evt.metadata.fromFeedbackCommentId).toBe(feedback.comment.id);
    expect(res.revision.reason).toBe("Client feedback");
    // a comment of another job → 404
    const other = (await insertJobFixture(db, ids, { statusKey: "delivered", createdByUserId: ids.users.owner })).job;
    expect(
      (await catchErr(as("owner", (tx, ctx) => requestRevision(tx, ctx, { jobId: other.id, expectedVersion: other.version, reason: "x", description: "y", fromFeedbackCommentId: feedback.comment.id })))).status,
    ).toBe(404);
  });
});

describe("actor checks run before version and state checks (403, never 409 / 422)", () => {
  const STALE = 999;

  it("a see-other-editors' jobs editor gets 403 (not 409 with the row) on every editor action of another editor's job", async () => {
    await setUserFlags(db, ids.users.editor2, { canViewTeamJobs: true });
    const assigned = (await insertJobFixture(db, ids, { statusKey: "assigned", editorId: ids.users.editor1 })).job;
    const accepted = (await insertJobFixture(db, ids, { statusKey: "accepted", editorId: ids.users.editor1 })).job;
    const working = (await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 })).job;
    const attempts: [string, (tx: Tx, ctx: AuthContext) => Promise<unknown>][] = [
      ["accept", (tx, ctx) => acceptJob(tx, ctx, { jobId: assigned.id, expectedVersion: STALE })],
      ["decline", (tx, ctx) => declineJob(tx, ctx, { jobId: assigned.id, expectedVersion: STALE })],
      ["start", (tx, ctx) => startJob(tx, ctx, { jobId: accepted.id, expectedVersion: STALE })],
      ["submit", (tx, ctx) => submitJob(tx, ctx, { jobId: working.id, expectedVersion: STALE })],
      ["transition", (tx, ctx) => transitionJobStatus(tx, ctx, { jobId: working.id, expectedVersion: STALE, toCategory: "submitted" })],
      ["update", (tx, ctx) => updateJob(tx, ctx, { jobId: working.id, expectedVersion: STALE, completionPercent: 50 })],
      ["priority", (tx, ctx) => setPriority(tx, ctx, { jobId: working.id, expectedVersion: STALE, priority: "urgent" })],
    ];
    for (const [label, fn] of attempts) {
      const err = await catchErr(as("editor2", fn));
      expect({ label, status: err.status, code: err.code }).toEqual({ label, status: 403, code: "forbidden" });
      expect(JSON.stringify(err.details ?? null)).not.toContain("createdByUserId");
    }
    // The holder still gets the optimistic-concurrency 409 on a stale version.
    expect((await catchErr(as("editor1", (tx, ctx) => submitJob(tx, ctx, { jobId: working.id, expectedVersion: STALE })))).status).toBe(409);
    for (const j of [assigned, accepted, working]) expect((await jobRow(j.id)).version).toBe(j.version);
  });

  it("revision resolve: a read-only team viewer gets 403 before the version check", async () => {
    await setUserFlags(db, ids.users.editor2, { canViewTeamJobs: true });
    const job = (await insertJobFixture(db, ids, { statusKey: "review", editorId: ids.users.editor1 })).job;
    const r = await as("owner", (tx, ctx) =>
      requestRevision(tx, ctx, { jobId: job.id, expectedVersion: job.version, reason: "Colour", description: "Kitchen too cold" }),
    );
    const err = await catchErr(as("editor2", (tx, ctx) => resolveRevision(tx, ctx, { revisionId: r.revision.id, expectedVersion: 1 })));
    expect([err.status, err.code]).toEqual([403, "forbidden"]);
    // A member who can read but not request revisions: 403 on request, not 409.
    const err2 = await catchErr(
      as("lead", (tx, ctx) => requestRevision(tx, ctx, { jobId: job.id, expectedVersion: STALE, reason: "x", description: "y" })),
    );
    expect(err2.status).toBe(403);
    expect((await catchErr(as("editor1", (tx, ctx) => resolveRevision(tx, ctx, { revisionId: r.revision.id, expectedVersion: STALE })))).status).toBe(409);
  });

  it("a member with every switch reopening an unmanaged completed job whose editor is inactive gets 403, not 422 editor_required", async () => {
    const completed = (await insertJobFixture(db, ids, { statusKey: "completed", editorId: ids.users.inactiveEditor })).job;
    const err = await catchErr(as("lead", (tx, ctx) => reopenJob(tx, ctx, { jobId: completed.id, expectedVersion: completed.version, reason: "x" })));
    expect([err.status, err.code]).toEqual([403, "forbidden"]);
    // Stale version too: still 403 (actor first).
    expect((await catchErr(as("lead", (tx, ctx) => reopenJob(tx, ctx, { jobId: completed.id, expectedVersion: STALE, reason: "x" })))).status).toBe(403);
    // Free-form transition to a category with no edge from here: 403, not 422 invalid_transition.
    const working = (await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 })).job;
    const bad = await catchErr(moveAs(ids.users.lead, working.id, { toCategory: "new" }));
    expect([bad.status, bad.code]).toEqual([403, "forbidden"]);
    // A member who manages the job but lacks Review submissions: the move permission (job.reopen) wins over the editor precondition.
    const member = await junior();
    await setUserFlags(db, member, { canReviewSubmissions: false });
    const own = (await insertJobFixture(db, ids, { statusKey: "completed", editorId: ids.users.inactiveEditor, createdByUserId: member, photographerId: member })).job;
    const denied = await catchErr(asUser(member, (tx, ctx) => reopenJob(tx, ctx, { jobId: own.id, expectedVersion: own.version, reason: "x" })));
    expect([denied.status, denied.code]).toEqual([403, "forbidden"]);
    // An authorised actor still meets the precondition: the owner gets 422 editor_required.
    const pre = await catchErr(as("owner", (tx, ctx) => reopenJob(tx, ctx, { jobId: completed.id, expectedVersion: completed.version, reason: "x" })));
    expect([pre.status, pre.code]).toEqual([422, "editor_required"]);
    // Restore of a cancelled job: same order.
    const cancelled = (await insertJobFixture(db, ids, { statusKey: "cancelled" })).job;
    expect((await catchErr(as("lead", (tx, ctx) => restoreJob(tx, ctx, { jobId: cancelled.id, expectedVersion: STALE, reason: "x" })))).status).toBe(403);
    for (const j of [completed, working, own, cancelled]) expect((await jobRow(j.id)).version).toBe(j.version);
  });
});
