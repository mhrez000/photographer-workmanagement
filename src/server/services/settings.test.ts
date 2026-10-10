import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, organisationSettings, organisations, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { dismissRolesNotice, getSettings, updateSettings } from "./settings";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

async function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> {
  const ctx = await contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

const settingsEvents = async () => db.select().from(activityEvents).where(eq(activityEvents.eventType, "settings.updated")).orderBy(activityEvents.rowid);

describe("settings", () => {
  it("admins can view; team members (even with every switch), editors and clients cannot", async () => {
    expect((await getSettings(db, await contextFor(db, ids.users.coAdmin))).settings.timezone).toBe("Australia/Sydney");
    expect((await getSettings(db, await contextFor(db, ids.users.owner))).organisation.id).toBe(ids.organisationId);
    await expect(getSettings(db, await contextFor(db, ids.users.lead))).rejects.toThrow(ForbiddenError);
    await expect(getSettings(db, await contextFor(db, ids.users.photographer1))).rejects.toThrow(ForbiddenError);
    await expect(getSettings(db, await contextFor(db, ids.users.editor1))).rejects.toThrow(ForbiddenError);
    await expect(getSettings(db, await contextFor(db, ids.users.client))).rejects.toThrow(ForbiddenError);
  });

  it("only admins may update (v1 managers could not: their v2 equivalent, a fully-switched member, cannot either)", async () => {
    await expect(run(ids.users.lead, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 7 }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.photographer1, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 7 }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.editor1, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 7 }))).rejects.toThrow(ForbiddenError);
    expect(await settingsEvents()).toHaveLength(0);
    const res = await run(ids.users.coAdmin, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 7 }));
    expect(res.changedFields).toEqual(["stalledDays"]);
    expect((await settingsEvents())[0].actorUserId).toBe(ids.users.coAdmin);
  });

  it("writes one management event per changed field and bumps the version once", async () => {
    const res = await run(ids.users.owner, (tx, ctx) =>
      updateSettings(tx, ctx, {
        expectedVersion: 1,
        stalledDays: 7,
        timeTrackingEnabled: true,
        jobNumberPrefix: "nl",
        reviewSlaHours: 24, // unchanged → no event
        organisationName: "Northlight Studios",
      }),
    );
    expect(res.changedFields.sort()).toEqual(["jobNumberPrefix", "organisationName", "stalledDays", "timeTrackingEnabled"].sort());
    expect(res.settings).toMatchObject({ stalledDays: 7, timeTrackingEnabled: true, jobNumberPrefix: "NL", version: 2 });
    expect(res.organisation.name).toBe("Northlight Studios");

    const events = await settingsEvents();
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.visibility === "management" && e.entityType === "settings" && e.entityId === ids.organisationId)).toBe(true);
    const stalled = events.find((e) => (e.newValue as { field: string }).field === "stalledDays");
    expect(stalled?.previousValue).toEqual({ field: "stalledDays", value: 5 });
    expect(stalled?.newValue).toEqual({ field: "stalledDays", value: 7 });
    expect(stalled?.summary).toMatch(/from 5 to 7$/);
    expect((await first(db.select().from(organisations).where(eq(organisations.id, ids.organisationId))))?.name).toBe("Northlight Studios");
  });

  it("no change → no event, no version bump", async () => {
    const res = await run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 5 }));
    expect(res.changedFields).toEqual([]);
    expect(res.settings.version).toBe(1);
    expect(await settingsEvents()).toHaveLength(0);
  });

  it("validates values and cross-field ratios; rejects unknown keys and stale versions", async () => {
    await expect(run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { timezone: "Mars/Olympus" }))).rejects.toThrow(ValidationError);
    await expect(run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 0 }))).rejects.toThrow(ValidationError);
    await expect(run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { workloadNearCapacityRatio: 1.2 }))).rejects.toThrow(/near-capacity/);
    await expect(run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { lastOverdueSweepAt: "2026-01-01" }))).rejects.toThrow(ValidationError);
    await expect(run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 9, expectedVersion: 3 }))).rejects.toThrow(ConflictError);
    expect(await settingsEvents()).toHaveLength(0);
  });

  it("roles v2: the deprecated org visibility switches and the dedicated-writer columns are rejected (400, no change)", async () => {
    for (const key of [
      "photographersSeeAllJobs",
      "photographersSeeTeamJobs",
      "editorsSeeTeamJobs",
      "editorsSeeTeamWorkloads",
      "primaryOwnerUserId",
      "rolesV2NoticeDismissedAt",
    ]) {
      const value = key.endsWith("Id") || key.endsWith("At") ? ids.users.coAdmin : true;
      await expect(run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { [key]: value }))).rejects.toThrow(ValidationError);
    }
    const row = await first(db.select().from(organisationSettings));
    expect(row).toMatchObject({ photographersSeeAllJobs: false, primaryOwnerUserId: ids.users.owner, rolesV2NoticeDismissedAt: null, version: 1 });
    expect(await settingsEvents()).toHaveLength(0);
  });

  it("settings changes take effect on the next context", async () => {
    await run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { timezone: "Australia/Perth", timeTrackingEnabled: true }));
    const ctx = await contextFor(db, ids.users.photographer1);
    expect(ctx.settings).toMatchObject({ timezone: "Australia/Perth", timeTrackingEnabled: true });
    expect(ctx.settings).not.toHaveProperty("photographersSeeAllJobs");
    expect((await first(db.select().from(organisationSettings)))?.timezone).toBe("Australia/Perth");
  });

  it("default photographer for editor-created jobs: an active photographer of the org, or null (= primary owner)", async () => {
    const res = await run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { defaultPhotographerUserId: ids.users.photographer2 }));
    expect(res.settings.defaultPhotographerUserId).toBe(ids.users.photographer2);
    const [ev] = await settingsEvents();
    expect(ev).toMatchObject({ previousValue: { field: "defaultPhotographerUserId", value: null }, newValue: { field: "defaultPhotographerUserId", value: ids.users.photographer2 } });
    expect(ev.metadata).toMatchObject({ previousName: null, nextName: "Paul Photographer" });

    // allow-list: editors, client users, inactive photographers → 422; foreign ids → 404
    await expect(run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { defaultPhotographerUserId: ids.users.editor1 }))).rejects.toMatchObject({
      status: 422,
    });
    await expect(run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { defaultPhotographerUserId: ids.users.client }))).rejects.toMatchObject({
      status: 422,
    });
    await db.update(users).set({ isActive: false }).where(eq(users.id, ids.users.photographer1));
    await expect(run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { defaultPhotographerUserId: ids.users.photographer1 }))).rejects.toMatchObject({
      status: 422,
    });
    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { defaultPhotographerUserId: other.users.owner }))).rejects.toThrow(NotFoundError);

    const cleared = await run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { defaultPhotographerUserId: null }));
    expect(cleared.settings.defaultPhotographerUserId).toBeNull();
    expect(await settingsEvents()).toHaveLength(2);
  });

  it("dismissing the post-migration roles notice: admin only, audited once, idempotent", async () => {
    await expect(run(ids.users.lead, (tx, ctx) => dismissRolesNotice(tx, ctx, {}))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.owner, (tx, ctx) => dismissRolesNotice(tx, ctx, { expectedVersion: 7 }))).rejects.toThrow(ConflictError);
    const res = await run(ids.users.coAdmin, (tx, ctx) => dismissRolesNotice(tx, ctx, { expectedVersion: 1 }));
    expect(res.settings).toMatchObject({ rolesV2NoticeDismissedAt: "2026-10-08T00:00:00.000Z", version: 2 });
    await run(ids.users.owner, (tx, ctx) => dismissRolesNotice(tx, ctx, {}));
    const events = await settingsEvents();
    expect(events).toHaveLength(1);
    expect(events[0].newValue).toEqual({ field: "rolesV2NoticeDismissedAt", value: "2026-10-08T00:00:00.000Z" });
  });
});
