/**
 * Roles v2 comment rules (docs/ROLES.md §3.3 ‡, §6.4, §7.5): client threads
 * (client roots, staff replies, kind consistency, no mentions, feedback switch),
 * editors read-only in client threads, ⚑all members comment on any visible job,
 * question routing, notifications, and the editor read cut-off.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { notifications } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, inviteDefaultsMember, makeTestDb, seedMinimalOrg, setUserFlags, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { AppError } from "@/server/errors";
import { withTx } from "./_shared";
import { assignEditor } from "./assignments";
import { addComment, deleteComment, editComment, listComments } from "./comments";

let db: TestDb;
let ids: SeedIds;
let jobId: string;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  // Owner's own shoot, shared with Harbour Realty (portal + feedback on), editor1 edits it.
  jobId = (await insertJobFixture(db, ids, { statusKey: "delivered", createdByUserId: ids.users.owner, photographerId: ids.users.owner, sharedWithClient: true })).job.id;
});
afterEach(() => fakeClock.reset());

async function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T>): Promise<T> {
  const ctx = await contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}
async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err.status;
    throw err;
  }
  return 200;
}
const notificationsOf = (type: string) => db.select().from(notifications).where(eq(notifications.type, type as never));
const feedback = (userId: string, body: string, parentCommentId?: string) =>
  run(userId, (tx, ctx) => addComment(tx, ctx, { jobId, kind: "client_feedback", body, ...(parentCommentId ? { parentCommentId } : {}) }));

describe("client threads", () => {
  it("clients start threads; staff reply with client_feedback.reply; kinds stay consistent; no mentions", async () => {
    const root = await feedback(ids.users.client, "Could the hero shot be warmer?");
    expect(root.comment).toMatchObject({ kind: "client_feedback", authorUserId: ids.users.client, rootCommentId: root.comment.id });
    // staff cannot start a client thread
    expect(await status(run(ids.users.owner, (tx, ctx) => addComment(tx, ctx, { jobId, kind: "client_feedback", body: "x" })))).toBe(422);
    // staff reply: must be client_feedback inside a client thread
    expect(await status(run(ids.users.owner, (tx, ctx) => addComment(tx, ctx, { jobId, body: "internal reply", parentCommentId: root.comment.id })))).toBe(422);
    expect(
      await status(run(ids.users.owner, (tx, ctx) => addComment(tx, ctx, { jobId, kind: "client_feedback", body: "@Eve", parentCommentId: root.comment.id, mentionUserIds: [ids.users.editor1] }))),
    ).toBe(422);
    const reply = await run(ids.users.owner, (tx, ctx) => addComment(tx, ctx, { jobId, kind: "client_feedback", body: "We'll warm it up", parentCommentId: root.comment.id }));
    expect(reply.comment).toMatchObject({ kind: "client_feedback", rootCommentId: root.comment.id });
    // a staff thread never contains client_feedback replies
    const staff = await run(ids.users.owner, (tx, ctx) => addComment(tx, ctx, { jobId, body: "Internal: keep this grade" }));
    expect(await status(run(ids.users.owner, (tx, ctx) => addComment(tx, ctx, { jobId, kind: "client_feedback", body: "x", parentCommentId: staff.comment.id })))).toBe(422);
    // clients can never use staff kinds
    expect(await status(run(ids.users.client, (tx, ctx) => addComment(tx, ctx, { jobId, body: "hi" })))).toBe(403);
  });

  it("notifications: client post → photographer / creator / admins once each; staff reply → the client's portal users", async () => {
    const root = await feedback(ids.users.client, "Love these!");
    const staffNotices = await notificationsOf("client_feedback");
    // the owner is photographer ∪ creator ∪ admin: exactly one notice; editors are not told
    expect(staffNotices.map((n) => n.userId).sort()).toEqual([ids.users.coAdmin, ids.users.owner].sort());
    expect(staffNotices.some((n) => n.userId === ids.users.editor1)).toBe(false);
    await run(ids.users.owner, (tx, ctx) => addComment(tx, ctx, { jobId, kind: "client_feedback", body: "Thanks!", parentCommentId: root.comment.id }));
    expect((await notificationsOf("client_feedback_reply")).map((n) => n.userId)).toEqual([ids.users.client]);
    // clients never receive comment_added
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, ids.users.client), eq(notifications.type, "comment_added")))).toEqual([]);
  });

  it("feedback switch, portal visibility and other clients", async () => {
    // client2 (another client) cannot see the job → 404
    expect(await status(feedback(ids.users.client2, "hello"))).toBe(404);
    const root = await feedback(ids.users.client, "First");
    // client2's own job with feedback off → 403
    const theirs = (await insertJobFixture(db, ids, { statusKey: "delivered", createdByUserId: ids.users.owner, projectId: ids.projectId2, sharedWithClient: true })).job.id;
    expect(await status(run(ids.users.client2, (tx, ctx) => addComment(tx, ctx, { jobId: theirs, kind: "client_feedback", body: "x" })))).toBe(403);
    // an unshared job of the right client → 404
    const unshared = (await insertJobFixture(db, ids, { statusKey: "in_progress", createdByUserId: ids.users.owner })).job.id;
    expect(await status(run(ids.users.client, (tx, ctx) => addComment(tx, ctx, { jobId: unshared, kind: "client_feedback", body: "x" })))).toBe(404);
    // a client cannot edit / delete a staff comment or reply into a staff thread (404, no oracle)
    const staff = await run(ids.users.owner, (tx, ctx) => addComment(tx, ctx, { jobId, body: "Internal" }));
    expect(await status(run(ids.users.client, (tx, ctx) => editComment(tx, ctx, { commentId: staff.comment.id, body: "x" })))).toBe(404);
    expect(await status(run(ids.users.client, (tx, ctx) => deleteComment(tx, ctx, { commentId: staff.comment.id })))).toBe(404);
    expect(await status(feedback(ids.users.client, "reply", staff.comment.id))).toBe(404);
    // own feedback: edit within the window, delete
    expect((await run(ids.users.client, (tx, ctx) => editComment(tx, ctx, { commentId: root.comment.id, body: "First (edited)" }))).editCount).toBe(1);
    fakeClock.advanceMinutes(20);
    expect(await status(run(ids.users.client, (tx, ctx) => editComment(tx, ctx, { commentId: root.comment.id, body: "late" })))).toBe(403);
    expect((await run(ids.users.client, (tx, ctx) => deleteComment(tx, ctx, { commentId: root.comment.id }))).deletedAt).not.toBeNull();
  });

  it("editors read client threads on jobs they can see but cannot reply", async () => {
    const root = await feedback(ids.users.client, "Warmer please");
    const tree = await listComments(db, await contextFor(db, ids.users.editor1), jobId);
    expect(tree.map((c) => c.kind)).toEqual(["client_feedback"]);
    expect(await status(run(ids.users.editor1, (tx, ctx) => addComment(tx, ctx, { jobId, kind: "client_feedback", body: "On it", parentCommentId: root.comment.id })))).toBe(403);
  });
});

describe("staff comments", () => {
  it("a member with See all jobs may comment on a job they don't manage; without it the job is invisible", async () => {
    expect(await status(run(ids.users.photographer2, (tx, ctx) => addComment(tx, ctx, { jobId, body: "Nice" })))).toBe(404);
    await setUserFlags(db, ids.users.photographer2, { canViewAllJobs: true });
    const res = await run(ids.users.photographer2, (tx, ctx) => addComment(tx, ctx, { jobId, body: "Nice", mentionUserIds: [ids.users.owner] }));
    expect(res.mentionUserIds).toEqual([ids.users.owner]);
    // client users can never be mentioned
    expect(await status(run(ids.users.owner, (tx, ctx) => addComment(tx, ctx, { jobId, body: "@client", mentionUserIds: [ids.users.client] })))).toBe(422);
  });

  it("editor questions go to the photographer, and to every admin when the photographer cannot review", async () => {
    const member = await inviteDefaultsMember(db, ids); // review ✗
    const job = (await insertJobFixture(db, ids, { statusKey: "in_progress", createdByUserId: member, photographerId: member })).job.id;
    await run(ids.users.editor1, (tx, ctx) => addComment(tx, ctx, { jobId: job, kind: "question", body: "Pool cover on or off?" }));
    const recipients = (await notificationsOf("comment_added")).filter((n) => n.jobId === job);
    expect(recipients.map((n) => n.userId).sort()).toEqual([ids.users.coAdmin, member, ids.users.owner].sort());
    expect(recipients[0]?.title).toMatch(/^Question from Eve Editor/);

    // a photographer who can review: only them (no admins)
    const reviewed = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job.id; // photographer1, review ✓
    await run(ids.users.editor1, (tx, ctx) => addComment(tx, ctx, { jobId: reviewed, kind: "clarification_request", body: "Which crop?" }));
    expect((await notificationsOf("comment_added")).filter((n) => n.jobId === reviewed).map((n) => n.userId)).toEqual([ids.users.photographer1]);
  });

  it("past editors see comments up to their hand-over plus their own (read cut-off)", async () => {
    const job = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job;
    await run(ids.users.editor1, (tx, ctx) => addComment(tx, ctx, { jobId: job.id, body: "Mine, before" }));
    fakeClock.advanceMinutes(5);
    await run(ids.users.owner, (tx, ctx) => assignEditor(tx, ctx, { jobId: job.id, userId: ids.users.editor2, expectedVersion: job.version }));
    fakeClock.advanceMinutes(5);
    await run(ids.users.editor2, (tx, ctx) => addComment(tx, ctx, { jobId: job.id, body: "Theirs, after" }));
    const seen = (await listComments(db, await contextFor(db, ids.users.editor1), job.id)).map((c) => c.body);
    expect(seen).toEqual(["Mine, before"]);
    expect((await listComments(db, await contextFor(db, ids.users.owner), job.id)).map((c) => c.body)).toEqual(["Mine, before", "Theirs, after"]);
  });
});
