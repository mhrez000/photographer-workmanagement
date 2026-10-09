import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, organisationSettings, organisations } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { getSettings, updateSettings } from "./settings";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => T): T {
  const ctx = contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

const settingsEvents = () => db.select().from(activityEvents).where(eq(activityEvents.eventType, "settings.updated")).all();

describe("settings", () => {
  it("owners and managers can view; photographers/editors cannot", () => {
    expect(getSettings(db, contextFor(db, ids.users.manager)).settings.timezone).toBe("Australia/Sydney");
    expect(getSettings(db, contextFor(db, ids.users.owner)).organisation.id).toBe(ids.organisationId);
    expect(() => getSettings(db, contextFor(db, ids.users.photographer1))).toThrow(ForbiddenError);
    expect(() => getSettings(db, contextFor(db, ids.users.editor1))).toThrow(ForbiddenError);
  });

  it("only the owner may update", () => {
    expect(() => run(ids.users.manager, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 7 }))).toThrow(ForbiddenError);
    expect(() => run(ids.users.photographer1, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 7 }))).toThrow(ForbiddenError);
  });

  it("writes one management event per changed field and bumps the version once", () => {
    const res = run(ids.users.owner, (tx, ctx) =>
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

    const events = settingsEvents();
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.visibility === "management" && e.entityType === "settings" && e.entityId === ids.organisationId)).toBe(true);
    const stalled = events.find((e) => (e.newValue as { field: string }).field === "stalledDays");
    expect(stalled?.previousValue).toEqual({ field: "stalledDays", value: 5 });
    expect(stalled?.newValue).toEqual({ field: "stalledDays", value: 7 });
    expect(stalled?.summary).toMatch(/from 5 to 7$/);
    expect(db.select().from(organisations).where(eq(organisations.id, ids.organisationId)).get()?.name).toBe("Northlight Studios");
  });

  it("no change → no event, no version bump", () => {
    const res = run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 5 }));
    expect(res.changedFields).toEqual([]);
    expect(res.settings.version).toBe(1);
    expect(settingsEvents()).toHaveLength(0);
  });

  it("validates values and cross-field ratios; rejects unknown keys and stale versions", () => {
    expect(() => run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { timezone: "Mars/Olympus" }))).toThrow(ValidationError);
    expect(() => run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 0 }))).toThrow(ValidationError);
    expect(() => run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { workloadNearCapacityRatio: 1.2 }))).toThrow(/near-capacity/);
    expect(() => run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { lastOverdueSweepAt: "2026-01-01" }))).toThrow(ValidationError);
    expect(() => run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { stalledDays: 9, expectedVersion: 3 }))).toThrow(ConflictError);
    expect(settingsEvents()).toHaveLength(0);
  });

  it("visibility flag changes take effect on the next context", () => {
    expect(contextFor(db, ids.users.photographer1).settings.photographersSeeAllJobs).toBe(false);
    run(ids.users.owner, (tx, ctx) => updateSettings(tx, ctx, { photographersSeeAllJobs: true, timezone: "Australia/Perth" }));
    const ctx = contextFor(db, ids.users.photographer1);
    expect(ctx.settings.photographersSeeAllJobs).toBe(true);
    expect(ctx.settings.timezone).toBe("Australia/Perth");
    expect(db.select().from(organisationSettings).get()?.timezone).toBe("Australia/Perth");
  });
});
