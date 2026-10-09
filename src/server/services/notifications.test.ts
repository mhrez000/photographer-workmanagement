import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityEvents, jobComments, notifications, userNotificationPrefs } from "@/db/schema";
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
import { NotFoundError } from "@/server/errors";
import { recordEvent } from "@/server/audit";
import { withTx } from "./_shared";
import { jobParticipants, managersOf, markAllRead, markRead, notify, unreadCount, type NotifyInput } from "./notifications";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

function send(actorId: string, input: Partial<NotifyInput> & Pick<NotifyInput, "userIds">) {
  const ctx = contextFor(db, actorId);
  return withTx(
    (tx) => notify(tx, ctx, { type: "comment_added", title: "New comment", linkPath: "/jobs/x", ...input }),
    { db },
  );
}

function rowsFor(userId: string) {
  return db.select().from(notifications).where(eq(notifications.userId, userId)).all();
}

describe("notify", () => {
  it("never notifies the actor and ignores null/duplicate ids", () => {
    const res = send(ids.users.manager, { userIds: [ids.users.manager, ids.users.editor1, ids.users.editor1, null, undefined] });
    expect(res.recipientIds).toEqual([ids.users.editor1]);
    expect(rowsFor(ids.users.manager)).toHaveLength(0);
    expect(rowsFor(ids.users.editor1)).toHaveLength(1);
    expect(rowsFor(ids.users.editor1)[0]).toMatchObject({ actorUserId: ids.users.manager, type: "comment_added", readAt: null });
  });

  it("skips inactive users and users of other organisations", () => {
    const other = seedMinimalOrg(db, { slug: "other" });
    const res = send(ids.users.manager, { userIds: [ids.users.inactiveEditor, other.users.editor1, ids.users.editor2] });
    expect(res.recipientIds).toEqual([ids.users.editor2]);
  });

  it("honours a disabled preference for optional types", () => {
    db.insert(userNotificationPrefs)
      .values({ organisationId: ids.organisationId, userId: ids.users.editor1, type: "comment_added", enabled: false })
      .run();
    const res = send(ids.users.manager, { userIds: [ids.users.editor1, ids.users.editor2] });
    expect(res.recipientIds).toEqual([ids.users.editor2]);
  });

  it("ignores preferences for mandatory types", () => {
    db.insert(userNotificationPrefs)
      .values({ organisationId: ids.organisationId, userId: ids.users.editor1, type: "mentioned", enabled: false })
      .run();
    const res = send(ids.users.manager, { userIds: [ids.users.editor1], type: "mentioned", title: "You were mentioned" });
    expect(res.recipientIds).toEqual([ids.users.editor1]);
  });

  it("an explicitly enabled preference row behaves like no row", () => {
    db.insert(userNotificationPrefs)
      .values({ organisationId: ids.organisationId, userId: ids.users.editor1, type: "comment_added", enabled: true })
      .run();
    expect(send(ids.users.manager, { userIds: [ids.users.editor1] }).recipientIds).toEqual([ids.users.editor1]);
  });

  it("dedupes per (user, activityEventId, type) but allows other types for the same event", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    const ctx = contextFor(db, ids.users.manager);
    const eventId = withTx(
      (tx) =>
        recordEvent(tx, ctx, { entityType: "job", entityId: job.id, jobId: job.id, eventType: "job.priority_changed", action: "updated" }),
      { db },
    );
    const first = send(ids.users.manager, { userIds: [ids.users.editor1], activityEventId: eventId, type: "priority_changed" });
    const again = send(ids.users.manager, { userIds: [ids.users.editor1, ids.users.editor2], activityEventId: eventId, type: "priority_changed" });
    const otherType = send(ids.users.manager, { userIds: [ids.users.editor1], activityEventId: eventId, type: "deadline_changed" });
    expect(first.recipientIds).toEqual([ids.users.editor1]);
    expect(again.recipientIds).toEqual([ids.users.editor2]);
    expect(otherType.recipientIds).toEqual([ids.users.editor1]);
    expect(rowsFor(ids.users.editor1)).toHaveLength(2);
  });

  it("dedupes per (user, dedupeKey) forever", () => {
    const sys = systemContextFor(db, ids.organisationId);
    const run = () =>
      withTx(
        (tx) =>
          notify(tx, sys, {
            userIds: [ids.users.editor1, ids.users.photographer1],
            type: "job_overdue",
            title: "Job overdue",
            linkPath: "/jobs/j1",
            dedupeKey: "overdue:j1:2026-10-07T12:59:59.999Z",
          }),
        { db },
      );
    expect(run().recipientIds.sort()).toEqual([ids.users.editor1, ids.users.photographer1].sort());
    fakeClock.advanceHours(1);
    expect(run().recipientIds).toEqual([]);
    expect(rowsFor(ids.users.editor1)).toHaveLength(1);
    expect(rowsFor(ids.users.editor1)[0].actorUserId).toBeNull();
  });

  it("writes notification.sent events only when audit_notifications is on", () => {
    send(ids.users.manager, { userIds: [ids.users.editor1] });
    expect(db.select().from(activityEvents).where(eq(activityEvents.eventType, "notification.sent")).all()).toHaveLength(0);

    const ctx = { ...contextFor(db, ids.users.manager) };
    ctx.settings = { ...ctx.settings, auditNotifications: true };
    withTx((tx) => notify(tx, ctx, { userIds: [ids.users.editor2], type: "comment_added", title: "x", linkPath: "/" }), { db });
    const events = db.select().from(activityEvents).where(eq(activityEvents.eventType, "notification.sent")).all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ visibility: "management", actorUserId: ids.users.manager });
  });
});

describe("recipient helpers", () => {
  it("managersOf returns active owners + managers of the org only", () => {
    seedMinimalOrg(db, { slug: "other" });
    expect(managersOf(db, ids.organisationId).sort()).toEqual([ids.users.manager, ids.users.owner].sort());
  });

  it("jobParticipants lists people and distinct non-deleted commenters", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    const at = fakeClock.now();
    const add = (authorUserId: string, deleted = false) =>
      db
        .insert(jobComments)
        .values({ organisationId: ids.organisationId, jobId: job.id, authorUserId, body: "hi", createdAt: at, deletedAt: deleted ? at : null })
        .returning({ id: jobComments.id })
        .get().id;
    add(ids.users.manager);
    add(ids.users.manager);
    add(ids.users.editor2, true);
    const p = jobParticipants(db, job.id);
    expect(p).toMatchObject({ photographerId: ids.users.photographer1, editorId: ids.users.editor1, createdByUserId: ids.users.photographer1 });
    expect(p.commenterIds).toEqual([ids.users.manager]);
    expect(() => jobParticipants(db, "missing")).toThrow(NotFoundError);
  });
});

describe("markRead / markAllRead / unreadCount", () => {
  it("marks only the actor's own notifications; others are 404", () => {
    send(ids.users.manager, { userIds: [ids.users.editor1, ids.users.editor2] });
    const editorCtx = contextFor(db, ids.users.editor1);
    expect(unreadCount(editorCtx, db)).toBe(1);
    const mine = rowsFor(ids.users.editor1)[0];
    const theirs = rowsFor(ids.users.editor2)[0];

    expect(() => withTx((tx) => markRead(tx, editorCtx, { notificationId: theirs.id }), { db })).toThrow(NotFoundError);
    fakeClock.advanceMinutes(2);
    const res = withTx((tx) => markRead(tx, editorCtx, { notificationId: mine.id }), { db });
    expect(res.readAt).toBe("2026-10-08T00:02:00.000Z");
    // idempotent: second call keeps the original read_at
    fakeClock.advanceMinutes(2);
    expect(withTx((tx) => markRead(tx, editorCtx, { notificationId: mine.id }), { db }).readAt).toBe("2026-10-08T00:02:00.000Z");
    expect(unreadCount(editorCtx, db)).toBe(0);
    expect(unreadCount(contextFor(db, ids.users.editor2), db)).toBe(1);
  });

  it("markAllRead clears every unread notification of the actor", () => {
    send(ids.users.manager, { userIds: [ids.users.editor1], type: "comment_added" });
    send(ids.users.manager, { userIds: [ids.users.editor1], type: "priority_changed", title: "Priority" });
    send(ids.users.manager, { userIds: [ids.users.editor2] });
    const ctx = contextFor(db, ids.users.editor1);
    expect(withTx((tx) => markAllRead(tx, ctx), { db })).toEqual({ updated: 2 });
    expect(unreadCount(ctx, db)).toBe(0);
    expect(db.select().from(notifications).where(and(eq(notifications.userId, ids.users.editor2))).get()?.readAt).toBeNull();
  });

  it("only read_at may change (DB guard)", () => {
    send(ids.users.manager, { userIds: [ids.users.editor1] });
    const row = rowsFor(ids.users.editor1)[0];
    expect(() => db.update(notifications).set({ title: "tampered" }).where(eq(notifications.id, row.id)).run()).toThrow(/read_at/);
  });
});
