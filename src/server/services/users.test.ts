import { compareSync } from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, jobAssignments, jobs, userNotificationPrefs, users, workSessions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { buildContextFromDb } from "@/server/auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import {
  anonymiseUser,
  changeRole,
  deactivateUser,
  getNotificationPrefs,
  inviteUser,
  inviteUserWithTempPassword,
  prepareTempPassword,
  reactivateUser,
  resetPassword,
  setCapacity,
  setNotificationPrefs,
  setVisibilityFlags,
  updateUser,
  type PreparedSecret,
} from "./users";

let db: TestDb;
let ids: SeedIds;
let secret: PreparedSecret;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
  secret = await prepareTempPassword(4);
});
afterEach(() => fakeClock.reset());

async function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> {
  const ctx = await contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}
const userRow = async (id: string) => first(db.select().from(users).where(eq(users.id, id)));
const eventsOf = async (type: string) =>
  db.select().from(activityEvents).where(eq(activityEvents.eventType, type)).orderBy(activityEvents.createdAt, activityEvents.rowid);

async function startSession(jobId: string, userId: string, transitionId: string, statusId: string) {
  await db.insert(workSessions).values({
    organisationId: ids.organisationId,
    jobId,
    userId,
    statusIdAtStart: statusId,
    categoryAtStart: "in_progress",
    transitionId,
    startedAt: "2026-10-07T23:00:00.000Z",
  });
}

describe("inviteUser", () => {
  it("creates the user with a one-time temp password and a management event without secrets", async () => {
    const res = await run(ids.users.manager, (tx, ctx) =>
      inviteUser(tx, ctx, { email: " New.Editor@Studio.test ", name: "Nia New", role: "editor", capacityHoursPerWeek: 30 }, secret),
    );
    expect(res.tempPassword).toBe(secret.tempPassword);
    expect(res.user).toMatchObject({ email: "new.editor@studio.test", role: "editor", isActive: true, capacityHoursPerWeek: 30 });
    expect(res.user).not.toHaveProperty("passwordHash");
    expect(compareSync(res.tempPassword, (await userRow(res.user.id))?.passwordHash ?? "")).toBe(true);

    const [ev] = await eventsOf("user.created");
    expect(ev).toMatchObject({ entityId: res.user.id, visibility: "management", actorUserId: ids.users.manager });
    expect(JSON.stringify([ev.newValue, ev.previousValue, ev.metadata])).not.toMatch(/password|\$2[aby]\$/i);
    expect(ev.summary).toBe("invited Nia New as Editor");
  });

  it("managers may only invite photographers/editors; P/E cannot invite; emails are unique", async () => {
    await expect(run(ids.users.manager, (tx, ctx) => inviteUser(tx, ctx, { email: "m2@studio.test", name: "M", role: "manager" }, secret))).rejects.toThrow(
      ForbiddenError,
    );
    await expect(run(ids.users.photographer1, (tx, ctx) => inviteUser(tx, ctx, { email: "x@studio.test", name: "X", role: "editor" }, secret))).rejects.toThrow(
      ForbiddenError,
    );
    await expect(run(ids.users.owner, (tx, ctx) => inviteUser(tx, ctx, { email: ids.emails.editor1, name: "Dup", role: "editor" }, secret))).rejects.toThrow(
      /already registered/,
    );
    const owner2 = await run(ids.users.owner, (tx, ctx) => inviteUser(tx, ctx, { email: "o2@studio.test", name: "Oscar", role: "owner" }, secret));
    expect(owner2.user.role).toBe("owner");
  });

  it("async convenience hashes outside the transaction", async () => {
    const res = await inviteUserWithTempPassword(await contextFor(db, ids.users.owner), { email: "async@studio.test", name: "Ash", role: "photographer" }, db);
    expect(res.tempPassword.length).toBeGreaterThanOrEqual(14);
    expect(compareSync(res.tempPassword, (await userRow(res.user.id))?.passwordHash ?? "")).toBe(true);
  });
});

describe("updateUser", () => {
  it("self edits name/title/avatar; email or other users need user.edit", async () => {
    const me = await run(ids.users.editor1, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.editor1, name: "Eve E.", title: "Senior editor" }));
    expect(me).toMatchObject({ name: "Eve E.", title: "Senior editor", version: 2 });
    expect((await eventsOf("user.updated"))[0].metadata).toMatchObject({ self: true, targetName: "Eve E." });

    await expect(run(ids.users.editor1, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.editor1, email: "eve@x.test" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.editor1, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.editor2, name: "Hacked" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.manager, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.owner, name: "Boss" }))).rejects.toThrow(ForbiddenError);

    const byManager = await run(ids.users.manager, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.editor2, email: "Ed@Studio.test" }));
    expect(byManager.email).toBe("ed@studio.test");
    await expect(run(ids.users.manager, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.editor2, email: ids.emails.editor1 }))).rejects.toThrow(
      /already registered/,
    );
  });

  it("foreign users are 404", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(run(ids.users.owner, (tx, ctx) => updateUser(tx, ctx, { userId: other.users.editor1, name: "X" }))).rejects.toThrow(NotFoundError);
    await expect(run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: other.users.editor1 }))).rejects.toThrow(NotFoundError);
  });
});

describe("changeRole", () => {
  it("manager limits: photographer ⇄ editor only", async () => {
    const res = await run(ids.users.manager, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.photographer2, role: "editor", expectedVersion: 1 }));
    expect(res.role).toBe("editor");
    expect((await userRow(ids.users.photographer2))?.sessionVersion).toBe(2);
    expect((await eventsOf("user.role_changed"))[0]).toMatchObject({ previousValue: { role: "photographer", name: "Paul Photographer" } });

    await expect(run(ids.users.manager, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.editor2, role: "manager" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.manager, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.owner, role: "editor" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.editor1, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.editor2, role: "photographer" }))).rejects.toThrow(ForbiddenError);
  });

  it("the last active owner cannot be demoted", async () => {
    await expect(run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.owner, role: "manager" }))).rejects.toThrow(/last active owner/);
    await run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.manager, role: "owner" }));
    const demoted = await run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.owner, role: "manager" }));
    expect(demoted.role).toBe("manager");
  });

  it("refuses to strand open assignments", async () => {
    await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    await expect(run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.editor1, role: "photographer" }))).rejects.toThrow(
      /open editing job/,
    );
    await insertJobFixture(db, ids, { statusKey: "new", photographerId: ids.users.photographer2 });
    await expect(run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.photographer2, role: "editor" }))).rejects.toThrow(
      /photographer on/,
    );
  });
});

describe("deactivateUser", () => {
  it("reassigns open editor jobs, stops the timer, bumps session_version and audits the job list", async () => {
    const a = await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    const b = await insertJobFixture(db, ids, { statusKey: "assigned", editorId: ids.users.editor1 });
    const done = await insertJobFixture(db, ids, { statusKey: "completed", editorId: ids.users.editor1 });
    await startSession(a.job.id, ids.users.editor1, a.transitionId, ids.statuses.in_progress);
    fakeClock.advanceHours(1);

    const res = await run(ids.users.manager, (tx, ctx) =>
      deactivateUser(tx, ctx, { userId: ids.users.editor1, reassignTo: ids.users.editor2, expectedVersion: 1 }),
    );
    expect(res.user).toMatchObject({ isActive: false, deactivatedByUserId: ids.users.manager, deactivatedAt: "2026-10-08T01:00:00.000Z" });
    expect(res.openJobs.map((j) => [j.jobId, j.action]).sort()).toEqual(
      [
        [a.job.id, "reassigned"],
        [b.job.id, "reassigned"],
      ].sort(),
    );

    const row = await userRow(ids.users.editor1);
    expect(row?.sessionVersion).toBe(2);
    expect(await buildContextFromDb(db, ids.users.editor1, { sessionVersion: 1 })).toBeNull();

    // jobs now held by editor2; mid-edit job keeps its status (re-attributed), assigned job stays assigned
    const jobA = await first(db.select().from(jobs).where(eq(jobs.id, a.job.id)));
    const jobB = await first(db.select().from(jobs).where(eq(jobs.id, b.job.id)));
    expect(jobA).toMatchObject({ editorId: ids.users.editor2, previousEditorId: ids.users.editor1, statusCategory: "in_progress" });
    expect(jobB).toMatchObject({ editorId: ids.users.editor2, statusCategory: "assigned" });
    // completed job untouched
    expect((await first(db.select().from(jobs).where(eq(jobs.id, done.job.id))))?.editorId).toBe(ids.users.editor1);

    // old assignments closed with user_deactivated
    const closed = await first(
      db
        .select()
        .from(jobAssignments)
        .where(and(eq(jobAssignments.userId, ids.users.editor1), eq(jobAssignments.jobId, a.job.id))),
    );
    expect(closed).toMatchObject({ unassignReason: "user_deactivated", unassignedByUserId: ids.users.manager });

    // running timer closed with auto_deactivated
    const session = await first(db.select().from(workSessions).where(eq(workSessions.userId, ids.users.editor1)));
    expect(session).toMatchObject({ endReason: "auto_deactivated", endedAt: "2026-10-08T01:00:00.000Z" });

    const [ev] = await eventsOf("user.deactivated");
    expect(ev.metadata).toMatchObject({ targetUserId: ids.users.editor1, reassignTo: ids.users.editor2 });
    expect((ev.metadata as { openJobs: unknown[] }).openJobs).toHaveLength(2);
    expect(ev.visibility).toBe("management");
  });

  it("unassign sends editor-held jobs back to Ready; no option keeps them (editor unavailable)", async () => {
    const a = await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    const res = await run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, unassign: true }));
    expect(res.openJobs).toEqual([{ jobId: a.job.id, jobNumber: a.job.jobNumber, role: "editor", action: "unassigned" }]);
    expect(await first(db.select().from(jobs).where(eq(jobs.id, a.job.id)))).toMatchObject({ editorId: null, statusCategory: "ready" });

    const b = await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor2 });
    const kept = await run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor2 }));
    expect(kept.openJobs[0]).toMatchObject({ jobId: b.job.id, action: "kept" });
    expect((await first(db.select().from(jobs).where(eq(jobs.id, b.job.id))))?.editorId).toBe(ids.users.editor2);
    const open = await first(
      db
        .select()
        .from(jobAssignments)
        .where(and(eq(jobAssignments.jobId, b.job.id), eq(jobAssignments.role, "editor"), isNull(jobAssignments.unassignedAt))),
    );
    expect(open?.userId).toBe(ids.users.editor2);
  });

  it("guards: self, manager → owner/manager, bad reassign target, already inactive", async () => {
    await expect(run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.owner }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.manager, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.owner }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.photographer1, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1 }))).rejects.toThrow(ForbiddenError);
    await expect(
      run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, reassignTo: ids.users.photographer1 })),
    ).rejects.toThrow(/active editor/);
    await expect(
      run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, reassignTo: ids.users.inactiveEditor })),
    ).rejects.toThrow(/active editor/);
    await expect(run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.inactiveEditor }))).rejects.toThrow(/already deactivated/);
    await expect(
      run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, reassignTo: ids.users.editor2, unassign: true })),
    ).rejects.toThrow(ValidationError);
    // nothing was written by the failed attempts
    expect(await eventsOf("user.deactivated")).toHaveLength(0);
    expect((await userRow(ids.users.editor1))?.isActive).toBe(true);
  });

  it("a whole deactivation rolls back if one reassignment fails", async () => {
    await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, reassignTo: other.users.editor1 }))).rejects.toThrow(
      NotFoundError,
    );
    expect(await userRow(ids.users.editor1)).toMatchObject({ isActive: true, sessionVersion: 1 });
  });

  it("reactivate restores access", async () => {
    await run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor2 }));
    await expect(run(ids.users.owner, (tx, ctx) => reactivateUser(tx, ctx, { userId: ids.users.editor1 }))).rejects.toThrow(/already active/);
    const back = await run(ids.users.manager, (tx, ctx) => reactivateUser(tx, ctx, { userId: ids.users.editor2 }));
    expect(back).toMatchObject({ isActive: true, deactivatedAt: null });
    expect((await contextFor(db, ids.users.editor2)).isActive).toBe(true);
    expect(await eventsOf("user.reactivated")).toHaveLength(1);
  });
});

describe("resetPassword / capacity / flags", () => {
  it("resets with a new temp password and revokes sessions", async () => {
    const res = await run(ids.users.manager, (tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.editor1 }, secret));
    expect(compareSync(res.tempPassword, (await userRow(ids.users.editor1))?.passwordHash ?? "")).toBe(true);
    expect((await userRow(ids.users.editor1))?.sessionVersion).toBe(2);
    const [ev] = await eventsOf("user.password_changed");
    expect(ev.summary).toBe("reset the password for Eve Editor");
    expect(JSON.stringify(ev)).not.toContain(secret.passwordHash);

    await expect(run(ids.users.manager, (tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.owner }, secret))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.editor2, (tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.photographer1 }, secret))).rejects.toThrow(ForbiddenError);
    expect((await run(ids.users.editor2, (tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.editor2 }, secret))).userId).toBe(ids.users.editor2);
  });

  it("capacity and visibility flags are management-only and audited", async () => {
    const u = await run(ids.users.manager, (tx, ctx) => setCapacity(tx, ctx, { userId: ids.users.editor1, capacityHoursPerWeek: 32 }));
    expect(u.capacityHoursPerWeek).toBe(32);
    expect((await eventsOf("user.capacity_changed"))[0].summary).toBe("changed Eve Editor’s capacity from the default to 32 h/week");
    await expect(run(ids.users.editor1, (tx, ctx) => setCapacity(tx, ctx, { userId: ids.users.editor1, capacityHoursPerWeek: 60 }))).rejects.toThrow(
      ForbiddenError,
    );

    const p = await run(ids.users.owner, (tx, ctx) => setVisibilityFlags(tx, ctx, { userId: ids.users.photographer1, canViewAnalytics: true }));
    expect(p.canViewAnalytics).toBe(true);
    expect((await eventsOf("user.flags_changed"))[0]).toMatchObject({ previousValue: { canViewAnalytics: false }, newValue: { canViewAnalytics: true } });
    expect((await contextFor(db, ids.users.photographer1)).canViewAnalytics).toBe(true);
    await expect(run(ids.users.owner, (tx, ctx) => setVisibilityFlags(tx, ctx, { userId: ids.users.photographer1 }))).rejects.toThrow(ValidationError);
  });
});

describe("anonymiseUser", () => {
  it("owner-only, target must be deactivated; rewrites PII and blocks login", async () => {
    await expect(run(ids.users.owner, (tx, ctx) => anonymiseUser(tx, ctx, { userId: ids.users.editor1 }))).rejects.toThrow(/Deactivate/);
    await expect(run(ids.users.manager, (tx, ctx) => anonymiseUser(tx, ctx, { userId: ids.users.inactiveEditor }))).rejects.toThrow(ForbiddenError);

    const before = await userRow(ids.users.inactiveEditor);
    const res = await run(ids.users.owner, (tx, ctx) => anonymiseUser(tx, ctx, { userId: ids.users.inactiveEditor }));
    expect(res).toMatchObject({
      name: "Former team member",
      email: `anon-${ids.users.inactiveEditor}@invalid`,
      avatarColour: "#94a3b8",
      anonymisedAt: "2026-10-08T00:00:00.000Z",
    });
    const after = await userRow(ids.users.inactiveEditor);
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(compareSync("Password123!", after?.passwordHash ?? "")).toBe(false);

    const [ev] = await eventsOf("user.anonymised");
    expect(JSON.stringify([ev.previousValue, ev.newValue, ev.metadata])).not.toContain("Iris");
    await expect(run(ids.users.owner, (tx, ctx) => anonymiseUser(tx, ctx, { userId: ids.users.inactiveEditor }))).rejects.toThrow(/already/);
    await expect(run(ids.users.owner, (tx, ctx) => reactivateUser(tx, ctx, { userId: ids.users.inactiveEditor }))).rejects.toThrow(/anonymised/);
  });
});

describe("notification preferences", () => {
  it("toggles optional types, keeps mandatory ones on, audits changes", async () => {
    const prefs = await run(ids.users.editor1, (tx, ctx) => setNotificationPrefs(tx, ctx, { prefs: { comment_added: false, work_approved: true } }));
    expect(prefs.find((p) => p.type === "comment_added")?.enabled).toBe(false);
    expect(prefs.find((p) => p.type === "mentioned")).toMatchObject({ mandatory: true, enabled: true });
    expect(await db.select().from(userNotificationPrefs)).toHaveLength(1);
    const [ev] = await eventsOf("user.notification_prefs_changed");
    expect(ev).toMatchObject({ previousValue: { comment_added: true }, newValue: { comment_added: false } });

    // re-enable upserts the same row
    await run(ids.users.editor1, (tx, ctx) => setNotificationPrefs(tx, ctx, { prefs: { comment_added: true } }));
    expect(await db.select().from(userNotificationPrefs)).toHaveLength(1);
    expect((await getNotificationPrefs(db, await contextFor(db, ids.users.editor1))).find((p) => p.type === "comment_added")?.enabled).toBe(true);

    await expect(run(ids.users.editor1, (tx, ctx) => setNotificationPrefs(tx, ctx, { prefs: { mentioned: false } }))).rejects.toThrow(/cannot be turned off/);
    await expect(
      run(ids.users.owner, (tx, ctx) => setNotificationPrefs(tx, ctx, { userId: ids.users.editor1, prefs: { comment_added: false } })),
    ).rejects.toThrow(ForbiddenError);
    await expect(getNotificationPrefs(db, await contextFor(db, ids.users.owner), ids.users.editor1)).rejects.toThrow(ForbiddenError);
  });
});
