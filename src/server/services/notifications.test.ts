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
  dbRejection,
  type TestDb,
} from "@/db/test-db";
import { NotFoundError } from "@/server/errors";
import { recordEvent } from "@/server/audit";
import { withTx } from "./_shared";
import { jobParticipants, managersOf, markAllRead, markRead, notify, unreadCount, type NotifyInput } from "./notifications";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

async function send(actorId: string, input: Partial<NotifyInput> & Pick<NotifyInput, "userIds">) {
  const ctx = await contextFor(db, actorId);
  return withTx(
    (tx) => notify(tx, ctx, { type: "comment_added", title: "New comment", linkPath: "/jobs/x", ...input }),
    { db },
  );
}

function rowsFor(userId: string) {
  return db.select().from(notifications).where(eq(notifications.userId, userId));
}

describe("notify", () => {
  it("never notifies the actor and ignores null/duplicate ids", async () => {
    const res = await send(ids.users.manager, { userIds: [ids.users.manager, ids.users.editor1, ids.users.editor1, null, undefined] });
    expect(res.recipientIds).toEqual([ids.users.editor1]);
    expect(await rowsFor(ids.users.manager)).toHaveLength(0);
    expect(await rowsFor(ids.users.editor1)).toHaveLength(1);
    expect((await rowsFor(ids.users.editor1))[0]).toMatchObject({ actorUserId: ids.users.manager, type: "comment_added", readAt: null });
  });

  it("skips inactive users and users of other organisations", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    const res = await send(ids.users.manager, { userIds: [ids.users.inactiveEditor, other.users.editor1, ids.users.editor2] });
    expect(res.recipientIds).toEqual([ids.users.editor2]);
  });

  it("honours a disabled preference for optional types", async () => {
    await db.insert(userNotificationPrefs)
      .values({ organisationId: ids.organisationId, userId: ids.users.editor1, type: "comment_added", enabled: false });
    const res = await send(ids.users.manager, { userIds: [ids.users.editor1, ids.users.editor2] });
    expect(res.recipientIds).toEqual([ids.users.editor2]);
  });

  it("ignores preferences for mandatory types", async () => {
    await db.insert(userNotificationPrefs)
      .values({ organisationId: ids.organisationId, userId: ids.users.editor1, type: "mentioned", enabled: false });
    const res = await send(ids.users.manager, { userIds: [ids.users.editor1], type: "mentioned", title: "You were mentioned" });
    expect(res.recipientIds).toEqual([ids.users.editor1]);
  });

  it("an explicitly enabled preference row behaves like no row", async () => {
    await db.insert(userNotificationPrefs)
      .values({ organisationId: ids.organisationId, userId: ids.users.editor1, type: "comment_added", enabled: true });
    expect((await send(ids.users.manager, { userIds: [ids.users.editor1] })).recipientIds).toEqual([ids.users.editor1]);
  });

  it("dedupes per (user, activityEventId, type) but allows other types for the same event", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const ctx = await contextFor(db, ids.users.manager);
    const eventId = await withTx(
      (tx) =>
        recordEvent(tx, ctx, { entityType: "job", entityId: job.id, jobId: job.id, eventType: "job.priority_changed", action: "updated" }),
      { db },
    );
    const first = await send(ids.users.manager, { userIds: [ids.users.editor1], activityEventId: eventId, type: "priority_changed" });
    const again = await send(ids.users.manager, { userIds: [ids.users.editor1, ids.users.editor2], activityEventId: eventId, type: "priority_changed" });
    const otherType = await send(ids.users.manager, { userIds: [ids.users.editor1], activityEventId: eventId, type: "deadline_changed" });
    expect(first.recipientIds).toEqual([ids.users.editor1]);
    expect(again.recipientIds).toEqual([ids.users.editor2]);
    expect(otherType.recipientIds).toEqual([ids.users.editor1]);
    expect(await rowsFor(ids.users.editor1)).toHaveLength(2);
  });

  it("dedupes per (user, dedupeKey) forever", async () => {
    const sys = await systemContextFor(db, ids.organisationId);
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
    expect((await run()).recipientIds.sort()).toEqual([ids.users.editor1, ids.users.photographer1].sort());
    fakeClock.advanceHours(1);
    expect((await run()).recipientIds).toEqual([]);
    expect(await rowsFor(ids.users.editor1)).toHaveLength(1);
    expect((await rowsFor(ids.users.editor1))[0].actorUserId).toBeNull();
  });

  it("writes notification.sent events only when audit_notifications is on", async () => {
    await send(ids.users.manager, { userIds: [ids.users.editor1] });
    expect(await db.select().from(activityEvents).where(eq(activityEvents.eventType, "notification.sent"))).toHaveLength(0);

    const ctx = { ...(await contextFor(db, ids.users.manager)) };
    ctx.settings = { ...ctx.settings, auditNotifications: true };
    await withTx((tx) => notify(tx, ctx, { userIds: [ids.users.editor2], type: "comment_added", title: "x", linkPath: "/" }), { db });
    const events = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "notification.sent"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ visibility: "management", actorUserId: ids.users.manager });
  });
});

describe("recipient helpers", () => {
  it("managersOf returns active owners + managers of the org only", async () => {
    await seedMinimalOrg(db, { slug: "other" });
    expect((await managersOf(db, ids.organisationId)).sort()).toEqual([ids.users.manager, ids.users.owner].sort());
  });

  it("jobParticipants lists people and distinct non-deleted commenters", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const at = fakeClock.now();
    const add = async (authorUserId: string, deleted = false) => {
      const [row] = await db
        .insert(jobComments)
        .values({ organisationId: ids.organisationId, jobId: job.id, authorUserId, body: "hi", createdAt: at, deletedAt: deleted ? at : null })
        .returning({ id: jobComments.id });
      return row.id;
    };
    await add(ids.users.manager);
    await add(ids.users.manager);
    await add(ids.users.editor2, true);
    const p = await jobParticipants(db, job.id);
    expect(p).toMatchObject({ photographerId: ids.users.photographer1, editorId: ids.users.editor1, createdByUserId: ids.users.photographer1 });
    expect(p.commenterIds).toEqual([ids.users.manager]);
    await expect(jobParticipants(db, "missing")).rejects.toThrow(NotFoundError);
  });
});

describe("markRead / markAllRead / unreadCount", () => {
  it("marks only the actor's own notifications; others are 404", async () => {
    await send(ids.users.manager, { userIds: [ids.users.editor1, ids.users.editor2] });
    const editorCtx = await contextFor(db, ids.users.editor1);
    expect(await unreadCount(editorCtx, db)).toBe(1);
    const [mine] = await rowsFor(ids.users.editor1);
    const [theirs] = await rowsFor(ids.users.editor2);

    await expect(withTx((tx) => markRead(tx, editorCtx, { notificationId: theirs.id }), { db })).rejects.toThrow(NotFoundError);
    fakeClock.advanceMinutes(2);
    const res = await withTx((tx) => markRead(tx, editorCtx, { notificationId: mine.id }), { db });
    expect(res.readAt).toBe("2026-10-08T00:02:00.000Z");
    // idempotent: second call keeps the original read_at
    fakeClock.advanceMinutes(2);
    expect((await withTx((tx) => markRead(tx, editorCtx, { notificationId: mine.id }), { db })).readAt).toBe("2026-10-08T00:02:00.000Z");
    expect(await unreadCount(editorCtx, db)).toBe(0);
    expect(await unreadCount(await contextFor(db, ids.users.editor2), db)).toBe(1);
  });

  it("markAllRead clears every unread notification of the actor", async () => {
    await send(ids.users.manager, { userIds: [ids.users.editor1], type: "comment_added" });
    await send(ids.users.manager, { userIds: [ids.users.editor1], type: "priority_changed", title: "Priority" });
    await send(ids.users.manager, { userIds: [ids.users.editor2] });
    const ctx = await contextFor(db, ids.users.editor1);
    expect(await withTx((tx) => markAllRead(tx, ctx), { db })).toEqual({ updated: 2 });
    expect(await unreadCount(ctx, db)).toBe(0);
    expect((await db.select().from(notifications).where(and(eq(notifications.userId, ids.users.editor2))))[0]?.readAt).toBeNull();
  });

  it("only read_at may change (DB guard)", async () => {
    await send(ids.users.manager, { userIds: [ids.users.editor1] });
    const [row] = await rowsFor(ids.users.editor1);
    expect(await dbRejection(db.update(notifications).set({ title: "tampered" }).where(eq(notifications.id, row.id)))).toMatch(/read_at/);
  });
});
