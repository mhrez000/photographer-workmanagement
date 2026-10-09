import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import type { AuthContext } from "@/lib/types";
import { activityEvents, commentMentions, jobComments, notifications } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { withTx } from "./_shared";
import { InvalidMentionError, addComment, deleteComment, editComment, listComments } from "./comments";

let db: TestDb;
let ids: SeedIds;
let jobId: string;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
  // photographer1 owns it, editor1 is the current editor.
  jobId = insertJobFixture(db, ids, { statusKey: "in_progress" }).job.id;
});
afterEach(() => fakeClock.reset());

function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => T): T {
  const ctx = contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

function events(eventType: string) {
  return db.select().from(activityEvents).where(eq(activityEvents.eventType, eventType as never)).all();
}

function notificationsFor(userId: string, type?: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), type ? eq(notifications.type, type as never) : undefined))
    .all();
}

describe("addComment threading", () => {
  it("gives a root comment root_comment_id = its own id and replies inherit the root", () => {
    const root = run(ids.users.photographer1, (tx, ctx) => addComment(tx, ctx, { jobId, body: "First pass looks great" }));
    expect(root.comment.rootCommentId).toBe(root.comment.id);
    expect(root.comment.parentCommentId).toBeNull();

    const reply = run(ids.users.editor1, (tx, ctx) =>
      addComment(tx, ctx, { jobId, body: "Thanks!", parentCommentId: root.comment.id }),
    );
    expect(reply.comment.parentCommentId).toBe(root.comment.id);
    expect(reply.comment.rootCommentId).toBe(root.comment.id);

    const nested = run(ids.users.manager, (tx, ctx) =>
      addComment(tx, ctx, { jobId, body: "Agreed", parentCommentId: reply.comment.id, kind: "question" }),
    );
    expect(nested.comment.rootCommentId).toBe(root.comment.id);

    const tree = listComments(db, contextFor(db, ids.users.manager), jobId);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe(root.comment.id);
    expect(tree[0].replies.map((r) => r.id)).toEqual([reply.comment.id]);
    expect(tree[0].replies[0].replies.map((r) => r.id)).toEqual([nested.comment.id]);

    const added = events("comment.added");
    expect(added).toHaveLength(3);
    expect(added[0]).toMatchObject({ entityType: "comment", entityId: root.comment.id, jobId, action: "created" });
    expect(added[0].newValue).toMatchObject({ body: "First pass looks great", kind: "comment", rootCommentId: root.comment.id });
  });

  it("notifies photographer, editor, creator and prior thread commenters (never the author)", () => {
    const root = run(ids.users.manager, (tx, ctx) => addComment(tx, ctx, { jobId, body: "Please check the sky" }));
    expect(new Set(root.notifiedUserIds)).toEqual(new Set([ids.users.photographer1, ids.users.editor1]));
    expect(notificationsFor(ids.users.manager)).toHaveLength(0);

    const reply = run(ids.users.editor1, (tx, ctx) => addComment(tx, ctx, { jobId, body: "On it", parentCommentId: root.comment.id }));
    // manager is a prior commenter in the thread; editor (author) is skipped.
    expect(new Set(reply.notifiedUserIds)).toEqual(new Set([ids.users.photographer1, ids.users.manager]));
    const forManager = notificationsFor(ids.users.manager, "comment_added");
    expect(forManager).toHaveLength(1);
    expect(forManager[0].linkPath).toContain(reply.comment.id);
  });

  it("rejects replies to comments of another job and unknown jobs with 404", () => {
    const otherJob = insertJobFixture(db, ids, { statusKey: "in_progress" }).job.id;
    const root = run(ids.users.manager, (tx, ctx) => addComment(tx, ctx, { jobId: otherJob, body: "x" }));
    expect(() => run(ids.users.manager, (tx, ctx) => addComment(tx, ctx, { jobId, body: "y", parentCommentId: root.comment.id }))).toThrow(
      NotFoundError,
    );
    expect(() => run(ids.users.manager, (tx, ctx) => addComment(tx, ctx, { jobId: "nope", body: "y" }))).toThrow(NotFoundError);
  });

  it("returns 404 for a job of another organisation", () => {
    const other = seedMinimalOrg(db, { slug: "other" });
    const foreignJob = insertJobFixture(db, other, { statusKey: "in_progress" }).job.id;
    expect(() => run(ids.users.owner, (tx, ctx) => addComment(tx, ctx, { jobId: foreignJob, body: "hi" }))).toThrow(NotFoundError);
  });

  it("denies editors who are not the current editor (past/unassigned are read-only)", () => {
    // editor2 cannot even see the job → 404 (no existence oracle), not 403
    expect(() => run(ids.users.editor2, (tx, ctx) => addComment(tx, ctx, { jobId, body: "hi" }))).toThrow(NotFoundError);
  });
});

describe("@mentions", () => {
  it("writes mention rows, one comment.mentioned event each and a mandatory mentioned notification", () => {
    const res = run(ids.users.photographer1, (tx, ctx) =>
      addComment(tx, ctx, { jobId, body: "@Eve can you look?", mentionUserIds: [ids.users.editor1, ids.users.editor1, ids.users.manager] }),
    );
    expect(new Set(res.mentionUserIds)).toEqual(new Set([ids.users.editor1, ids.users.manager]));
    const rows = db.select().from(commentMentions).where(eq(commentMentions.commentId, res.comment.id)).all();
    expect(rows).toHaveLength(2);

    const mentioned = events("comment.mentioned");
    expect(mentioned).toHaveLength(2);
    expect(mentioned.map((e) => (e.newValue as { mentionedUserId: string }).mentionedUserId).sort()).toEqual(
      [ids.users.editor1, ids.users.manager].sort(),
    );
    expect(notificationsFor(ids.users.editor1, "mentioned")).toHaveLength(1);
    // A mentioned user is not also sent comment_added.
    expect(notificationsFor(ids.users.editor1, "comment_added")).toHaveLength(0);

    const tree = listComments(db, contextFor(db, ids.users.editor1), jobId);
    expect(tree[0].mentions.map((m) => m.id).sort()).toEqual([ids.users.editor1, ids.users.manager].sort());
  });

  it("rejects (422) a mention target who cannot view the job, listing the name, and writes nothing", () => {
    let err: unknown;
    try {
      run(ids.users.photographer1, (tx, ctx) => addComment(tx, ctx, { jobId, body: "hey", mentionUserIds: [ids.users.editor2] }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidMentionError);
    const e = err as InvalidMentionError;
    expect(e.status).toBe(422);
    expect(e.code).toBe("validation");
    expect(e.mention.names).toEqual(["Ed Editor"]);
    expect(e.mention.invalidUserIds).toEqual([ids.users.editor2]);
    expect(db.select().from(jobComments).all()).toHaveLength(0);
    expect(events("comment.added")).toHaveLength(0);
  });

  it("rejects inactive users and never names users of other organisations", () => {
    const other = seedMinimalOrg(db, { slug: "other" });
    let err: InvalidMentionError | undefined;
    try {
      run(ids.users.manager, (tx, ctx) =>
        addComment(tx, ctx, { jobId, body: "hey", mentionUserIds: [ids.users.inactiveEditor, other.users.owner] }),
      );
    } catch (e) {
      err = e as InvalidMentionError;
    }
    expect(err).toBeInstanceOf(InvalidMentionError);
    expect(err?.mention.names).toEqual(["Iris Inactive"]);
    expect(err?.mention.unknownCount).toBe(1);
    expect(err?.message).not.toContain("Olivia");
  });
});

describe("editComment", () => {
  it("lets the author edit within 15 minutes, stamping edited_at and bumping edit_count", () => {
    const { comment } = run(ids.users.editor1, (tx, ctx) => addComment(tx, ctx, { jobId, body: "Draft" }));
    fakeClock.advanceMinutes(14);
    const edited = run(ids.users.editor1, (tx, ctx) => editComment(tx, ctx, { commentId: comment.id, body: "Final" }));
    expect(edited.body).toBe("Final");
    expect(edited.editCount).toBe(1);
    expect(edited.editedAt).toBe(fakeClock.now());
    const ev = events("comment.edited");
    expect(ev).toHaveLength(1);
    expect(ev[0].previousValue).toEqual({ body: "Draft" });
    expect(ev[0].newValue).toEqual({ body: "Final" });
    expect(ev[0].metadata).toMatchObject({ commentId: comment.id, editCount: 1 });
  });

  it("refuses edits after the window and by anyone but the author", () => {
    const { comment } = run(ids.users.editor1, (tx, ctx) => addComment(tx, ctx, { jobId, body: "Draft" }));
    expect(() => run(ids.users.manager, (tx, ctx) => editComment(tx, ctx, { commentId: comment.id, body: "x" }))).toThrow(ForbiddenError);
    fakeClock.advanceMinutes(16);
    expect(() => run(ids.users.editor1, (tx, ctx) => editComment(tx, ctx, { commentId: comment.id, body: "late" }))).toThrow(
      ForbiddenError,
    );
    expect(events("comment.edited")).toHaveLength(0);
  });

  it("is a no-op for an unchanged body", () => {
    const { comment } = run(ids.users.editor1, (tx, ctx) => addComment(tx, ctx, { jobId, body: "Same" }));
    const res = run(ids.users.editor1, (tx, ctx) => editComment(tx, ctx, { commentId: comment.id, body: "  Same " }));
    expect(res.editCount).toBe(0);
    expect(events("comment.edited")).toHaveLength(0);
  });
});

describe("deleteComment", () => {
  it("soft-deletes (body retained in the DB, placeholder in the tree) and is idempotent", () => {
    const { comment } = run(ids.users.photographer1, (tx, ctx) => addComment(tx, ctx, { jobId, body: "Oops" }));
    run(ids.users.editor1, (tx, ctx) => addComment(tx, ctx, { jobId, body: "reply", parentCommentId: comment.id }));
    const deleted = run(ids.users.photographer1, (tx, ctx) => deleteComment(tx, ctx, { commentId: comment.id }));
    expect(deleted.deletedAt).toBe(fakeClock.now());
    expect(deleted.deletedByUserId).toBe(ids.users.photographer1);
    expect(db.select().from(jobComments).where(eq(jobComments.id, comment.id)).get()?.body).toBe("Oops");

    const tree = listComments(db, contextFor(db, ids.users.editor1), jobId);
    expect(tree[0]).toMatchObject({ id: comment.id, body: null, canEdit: false });
    expect(tree[0].replies).toHaveLength(1);

    run(ids.users.photographer1, (tx, ctx) => deleteComment(tx, ctx, { commentId: comment.id }));
    expect(events("comment.deleted")).toHaveLength(1);
    expect(events("comment.deleted")[0].previousValue).toEqual({ body: "Oops" });
  });

  it("lets managers delete anyone's comment but not other photographers/editors", () => {
    const { comment } = run(ids.users.editor1, (tx, ctx) => addComment(tx, ctx, { jobId, body: "Mine" }));
    expect(() => run(ids.users.photographer1, (tx, ctx) => deleteComment(tx, ctx, { commentId: comment.id }))).toThrow(ForbiddenError);
    const res = run(ids.users.manager, (tx, ctx) => deleteComment(tx, ctx, { commentId: comment.id }));
    expect(res.deletedByUserId).toBe(ids.users.manager);
  });
});

describe("listComments", () => {
  it("requires job.view", () => {
    run(ids.users.manager, (tx, ctx) => addComment(tx, ctx, { jobId, body: "hello" }));
    expect(() => listComments(db, contextFor(db, ids.users.editor2), jobId)).toThrow(NotFoundError); // invisible job → 404
    expect(listComments(db, contextFor(db, ids.users.photographer1), jobId)[0].canEdit).toBe(false);
    expect(listComments(db, contextFor(db, ids.users.manager), jobId)[0].canEdit).toBe(true);
  });
});
