import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, organisationSettings, organisations } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { getSettings, updateSettings } from "./settings";

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
  it("owners and managers can view; photographers/editors cannot", async () => {
    expect((await getSettings(db, await contextFor(db, ids.users.manager))).settings.timezone).toBe("Australia/Sydney");
    expect((await getSettings(db, await contextFor(db, ids.users.owner))).organisation.id).toBe(ids.organisationId);
    await expect(getSettings(db, await contextFor(db, ids.users.photographer1))).rejects.toThrow(ForbiddenError);
    await expect(getSettings(db, await contextFor(db, ids.users.editor1))).rejects.toThrow(ForbiddenError);
  });

  it("only the owner may update", async () => {
    await expect(run(ids.users.manager, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 7 }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.photographer1, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 7 }))).rejects.toThrow(ForbiddenError);
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

  it("visibility flag changes take effect on the next context", async () => {
    expect((await contextFor(db, ids.users.photographer1)).settings.photographersSeeAllJobs).toBe(false);
    await run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { photographersSeeAllJobs: true, timezone: "Australia/Perth" }));
    const ctx = await contextFor(db, ids.users.photographer1);
    expect(ctx.settings.photographersSeeAllJobs).toBe(true);
    expect(ctx.settings.timezone).toBe("Australia/Perth");
    expect((await first(db.select().from(organisationSettings)))?.timezone).toBe("Australia/Perth");
  });
});
