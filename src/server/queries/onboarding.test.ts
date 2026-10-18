/**
 * First-run checklist (front door): steps computed from data, admins only, `isNewStudio` (< 3 jobs and < 30
 * days), and the dismiss switch (`dismissOnboarding`, audited, idempotent).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityEvents, organisationSettings, organisations } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, systemContextFor, testPasswordHash, type SeedIds, type TestDb } from "@/db/test-db";
import { ForbiddenError } from "@/server/errors";
import { withTx } from "@/server/services/_shared";
import { bootstrapOrganisation, createOrganisationWithOwner } from "@/server/services/organisations";
import { dismissOnboarding } from "@/server/services/settings";
import { inviteUser } from "@/server/services/users";
import { NEW_STUDIO_MAX_AGE_DAYS, NEW_STUDIO_MAX_JOBS, getOnboarding } from "./onboarding";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const asAdmin = async () => getOnboarding(db, await contextFor(db, ids.users.owner));

describe("getOnboarding", () => {
  it("admins get the checklist; team members, editors, clients and the system get null", async () => {
    expect(await asAdmin()).not.toBeNull();
    expect(await getOnboarding(db, await contextFor(db, ids.users.coAdmin))).not.toBeNull();
    for (const key of ["lead", "photographer1", "editor1", "client"] as const) {
      expect(await getOnboarding(db, await contextFor(db, ids.users[key]))).toBeNull();
    }
    expect(await getOnboarding(db, await systemContextFor(db, ids.organisationId))).toBeNull();
  });

  it("steps are computed from the data; the fixture already has editors and clients but no jobs", async () => {
    const state = await asAdmin();
    expect(state).toMatchObject({
      steps: { createdFirstJob: false, invitedEditor: true, addedClient: true, assignedEditor: false, approvedFirst: false },
      completed: 2,
      total: 5,
      dismissed: false,
      dismissedAt: null,
      isNewStudio: true,
      jobCount: 0,
      studioAgeDays: 0,
      show: true,
    });
  });

  it("a studio fresh from sign-up has every step off and shows the checklist", async () => {
    const fresh = await withTx(
      async (tx) => {
        const created = await createOrganisationWithOwner(tx, { name: "Fresh Studio", owner: { name: "Fay Fresh", email: "fay@fresh.test", passwordHash: testPasswordHash() }, cause: "signup" });
        await bootstrapOrganisation(tx, { organisationId: created.organisationId, ownerUserId: created.ownerId, ctx: created.ctx });
        return created;
      },
      { db },
    );
    const state = await getOnboarding(db, await contextFor(db, fresh.ownerId));
    expect(state).toMatchObject({
      steps: { createdFirstJob: false, invitedEditor: false, addedClient: false, assignedEditor: false, approvedFirst: false },
      completed: 0,
      isNewStudio: true,
      show: true,
    });
    // a pending (not yet accepted) editor invite already counts as "invited an editor"
    const freshCtx = await contextFor(db, fresh.ownerId);
    await withTx((tx) => inviteUser(tx, freshCtx, { email: "ed@fresh.test", name: "Ed", role: "editor" }), { db });
    expect((await getOnboarding(db, await contextFor(db, fresh.ownerId)))?.steps.invitedEditor).toBe(true);
  });

  it("creating a job, assigning an editor and approving one tick their steps; 3+ jobs end 'new studio' (and hide the card)", async () => {
    await insertJobFixture(db, ids, { statusKey: "new", editorId: null });
    let state = await asAdmin();
    expect(state?.steps).toMatchObject({ createdFirstJob: true, assignedEditor: false, approvedFirst: false });
    expect(state).toMatchObject({ completed: 3, jobCount: 1, isNewStudio: true, show: true });

    await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    state = await asAdmin();
    expect(state?.steps.assignedEditor).toBe(true);
    expect(state).toMatchObject({ completed: 4, jobCount: 2, isNewStudio: true, show: true });

    await insertJobFixture(db, ids, { statusKey: "approved", editorId: ids.users.editor1 });
    state = await asAdmin();
    expect(state?.steps.approvedFirst).toBe(true);
    expect(state).toMatchObject({ completed: 5, jobCount: NEW_STUDIO_MAX_JOBS, isNewStudio: false, show: false });
  });

  it("an organisation older than NEW_STUDIO_MAX_AGE_DAYS is not new even with no jobs", async () => {
    const old = new Date(Date.parse(fakeClock.now()) - (NEW_STUDIO_MAX_AGE_DAYS + 1) * 86_400_000).toISOString();
    await db.update(organisations).set({ createdAt: old }).where(eq(organisations.id, ids.organisationId));
    const state = await asAdmin();
    expect(state).toMatchObject({ isNewStudio: false, show: false, studioAgeDays: NEW_STUDIO_MAX_AGE_DAYS + 1, jobCount: 0 });
    fakeClock.advanceDays(1);
    expect((await asAdmin())?.studioAgeDays).toBe(NEW_STUDIO_MAX_AGE_DAYS + 2);
  });
});

describe("dismissOnboarding", () => {
  it("admins dismiss once (audited settings.updated); a second call is a no-op; the checklist then reports dismissed and hides", async () => {
    const ownerCtx = await contextFor(db, ids.users.owner);
    const first = await withTx((tx) => dismissOnboarding(tx, ownerCtx), { db });
    expect(first).toEqual({ dismissedAt: "2026-10-08T00:00:00.000Z", changed: true });
    const row = (await db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, ids.organisationId)))[0];
    expect(row.onboardingDismissedAt).toBe("2026-10-08T00:00:00.000Z");
    const events = (await db.select().from(activityEvents).where(eq(activityEvents.eventType, "settings.updated"))).filter((e) => (e.metadata as { field?: string }).field === "onboardingDismissedAt");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorUserId: ids.users.owner, visibility: "management", newValue: { field: "onboardingDismissedAt", value: "2026-10-08T00:00:00.000Z" } });

    fakeClock.advanceMinutes(5);
    const coAdminCtx = await contextFor(db, ids.users.coAdmin);
    const second = await withTx((tx) => dismissOnboarding(tx, coAdminCtx), { db });
    expect(second).toEqual({ dismissedAt: "2026-10-08T00:00:00.000Z", changed: false });
    expect((await db.select().from(activityEvents).where(eq(activityEvents.eventType, "settings.updated"))).filter((e) => (e.metadata as { field?: string }).field === "onboardingDismissedAt")).toHaveLength(1);

    expect(await asAdmin()).toMatchObject({ dismissed: true, dismissedAt: "2026-10-08T00:00:00.000Z", show: false, isNewStudio: true });
  });

  it("non-admins cannot dismiss", async () => {
    for (const key of ["lead", "editor1", "client"] as const) {
      const ctx = await contextFor(db, ids.users[key]);
      await expect(withTx((tx) => dismissOnboarding(tx, ctx), { db })).rejects.toThrow(ForbiddenError);
    }
    expect((await db.select().from(organisationSettings))[0].onboardingDismissedAt).toBeNull();
  });
});
