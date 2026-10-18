/**
 * Organisation bootstrap (front door): the ONE function that builds a studio's structure — used by sign-up AND
 * the demo seed — produces the default workflow, the default types of shoot and the settings defaults, audited as
 * the owner; and the seed still passes verify through it.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first } from "@/db/index";
import { activityEvents, jobTypes, organisationSettings, organisations, users, workflowStatuses, workflowTransitions, workflows } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { fakeClock, makeTestDb, seedMinimalOrg, testPasswordHash, type TestDb } from "@/db/test-db";
import { DEFAULT_JOB_TYPES, DEFAULT_TIMEZONE, DEFAULT_USUAL_DAYS_BY_JOB_TYPE, DEFAULT_WORKFLOW_NAME, DEFAULT_WORKFLOW_STATUSES, DEFAULT_WORKFLOW_TRANSITIONS, SLUG_MAX_LENGTH } from "@/lib/constants";
import { withTx } from "./_shared";
import { bootstrapOrganisation, createOrganisationWithOwner, slugBase, uniqueSlug } from "./organisations";

let db: TestDb;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
});
afterEach(() => fakeClock.reset());

const OWNER = { name: "Mo Carter", email: "mo@northlight.test", passwordHash: testPasswordHash() };

async function createStudio(opts: { usualDays?: Readonly<Record<string, number>> | null; slug?: string; name?: string } = {}) {
  return withTx(
    async (tx) => {
      const created = await createOrganisationWithOwner(tx, { name: opts.name ?? "Northlight Studio", slug: opts.slug, timezone: "Australia/Brisbane", owner: OWNER, cause: "signup", requestId: "test-signup" });
      const structure = await bootstrapOrganisation(tx, { organisationId: created.organisationId, ownerUserId: created.ownerId, ctx: created.ctx, usualDays: opts.usualDays });
      return { created, structure };
    },
    { db },
  );
}

describe("slugs", () => {
  it("slugBase lower-cases, hyphenates, trims to SLUG_MAX_LENGTH and falls back to 'studio'", () => {
    expect(slugBase("Northlight Studio")).toBe("northlight-studio");
    expect(slugBase("  Mo's Photos & Film!  ")).toBe("mo-s-photos-film");
    expect(slugBase("Café Lumière")).toBe("cafe-lumiere");
    expect(slugBase("!!!")).toBe("studio");
    const long = slugBase("a".repeat(SLUG_MAX_LENGTH) + "-tail");
    expect(long).toHaveLength(SLUG_MAX_LENGTH);
    expect(long.endsWith("-")).toBe(false);
  });

  it("uniqueSlug adds -2, -3, … when the slug is taken", async () => {
    await seedMinimalOrg(db); // slug "studio"
    expect(await uniqueSlug(db, "Studio")).toBe("studio-2");
    expect(await uniqueSlug(db, "Brand New")).toBe("brand-new");
    await db.insert(organisations).values({ name: "x", slug: "studio-2", createdAt: fakeClock.now(), updatedAt: fakeClock.now() });
    expect(await uniqueSlug(db, "studio")).toBe("studio-3");
    // the fallback collides too
    expect(await uniqueSlug(db, "???")).toBe("studio-3");
  });
});

describe("createOrganisationWithOwner + bootstrapOrganisation", () => {
  it("creates organisation, settings defaults, an accepted admin owner (primary owner), the default workflow and the types of shoot in one transaction", async () => {
    const { created, structure } = await createStudio();
    expect(created.slug).toBe("northlight-studio");

    const org = await first(db.select().from(organisations).where(eq(organisations.id, created.organisationId)));
    expect(org).toMatchObject({ name: "Northlight Studio", slug: "northlight-studio" });

    const settings = await first(db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, created.organisationId)));
    expect(settings).toMatchObject({ primaryOwnerUserId: created.ownerId, timezone: "Australia/Brisbane", advancedToolsEnabled: false, timeTrackingEnabled: false, onboardingDismissedAt: null, emailNotificationsEnabled: false });

    const owner = await first(db.select().from(users).where(eq(users.id, created.ownerId)));
    expect(owner).toMatchObject({
      organisationId: created.organisationId,
      email: OWNER.email,
      role: "photographer",
      isAdmin: true,
      isActive: true,
      acceptedAt: "2026-10-08T00:00:00.000Z",
      invitedAt: null,
      canCreateJobs: true,
      canViewAllJobs: true,
      canAssignEditors: true,
      canReviewSubmissions: true,
      canViewTeamWorkloads: true,
      canViewAnalytics: true,
      canViewTeamJobs: false,
      passwordHash: OWNER.passwordHash,
    });
    expect(created.ctx).toMatchObject({ userId: created.ownerId, organisationId: created.organisationId, isAdmin: true, isPrimaryOwner: true });

    // the default workflow: every template status, every template edge, made the default
    const wf = await first(db.select().from(workflows).where(eq(workflows.organisationId, created.organisationId)));
    expect(wf).toMatchObject({ id: structure.workflow.workflow.id, name: DEFAULT_WORKFLOW_NAME, isDefault: true });
    const statuses = await db.select().from(workflowStatuses).where(eq(workflowStatuses.workflowId, structure.workflow.workflow.id));
    expect(statuses.map((s) => s.key).sort()).toEqual(DEFAULT_WORKFLOW_STATUSES.map((s) => s.key).sort());
    expect(Object.keys(structure.statuses).sort()).toEqual(DEFAULT_WORKFLOW_STATUSES.map((s) => s.key).sort());
    const byId = new Map(statuses.map((s) => [s.id, s.key]));
    const edges = new Set(
      (await db.select().from(workflowTransitions).where(eq(workflowTransitions.workflowId, structure.workflow.workflow.id))).map((t) => `${byId.get(t.fromStatusId)}->${byId.get(t.toStatusId)}`),
    );
    for (const t of DEFAULT_WORKFLOW_TRANSITIONS) expect(edges.has(`${t.from}->${t.to}`)).toBe(true);
    // a cancel edge exists from every open (non-terminal) status
    for (const s of statuses) {
      if (s.category === "cancelled" || s.category === "completed") continue;
      expect(edges.has(`${s.key}->cancelled`)).toBe(true);
    }

    // types of shoot: DEFAULT_JOB_TYPES on the default workflow with the default "usual days"
    const types = await db.select().from(jobTypes).where(eq(jobTypes.organisationId, created.organisationId)).orderBy(jobTypes.sortOrder);
    expect(types.map((t) => t.name)).toEqual(DEFAULT_JOB_TYPES.map((t) => t.name));
    expect(Object.keys(structure.jobTypes).sort()).toEqual(DEFAULT_JOB_TYPES.map((t) => t.name).sort());
    for (const t of types) {
      expect(t.workflowId).toBe(structure.workflow.workflow.id);
      expect(t.usualDaysToEdit).toBe(DEFAULT_USUAL_DAYS_BY_JOB_TYPE[t.name]);
      expect(structure.jobTypes[t.name]).toBe(t.id);
    }
  });

  it("is the same shape the test fixture's default workflow has (statuses + edges)", async () => {
    const fixture = await seedMinimalOrg(db, { slug: "fixture", emailDomain: "fixture.test" });
    const { structure } = await createStudio();
    expect(Object.keys(structure.statuses).sort()).toEqual(Object.keys(fixture.statuses).sort());
    const byId = new Map(structure.workflow.statuses.map((s) => [s.id, s.key]));
    const edges = structure.workflow.transitions.filter((t) => !t.archivedAt).map((t) => `${byId.get(t.fromStatusId)}->${byId.get(t.toStatusId)}`).sort();
    expect(edges).toEqual(Object.keys(fixture.transitions).sort());
  });

  it("usualDays null leaves every type without usual days; a custom map applies per name", async () => {
    const a = await createStudio({ usualDays: null, slug: "a" });
    const typesA = await db.select().from(jobTypes).where(eq(jobTypes.organisationId, a.created.organisationId));
    expect(typesA.every((t) => t.usualDaysToEdit === null)).toBe(true);

    const b = await withTx(
      async (tx) => {
        const created = await createOrganisationWithOwner(tx, { name: "B", slug: "b", owner: { ...OWNER, email: "b@northlight.test" } });
        await bootstrapOrganisation(tx, { organisationId: created.organisationId, ownerUserId: created.ownerId, usualDays: { Wedding: 42 } });
        return created;
      },
      { db },
    );
    const typesB = await db.select().from(jobTypes).where(eq(jobTypes.organisationId, b.organisationId));
    expect(typesB.find((t) => t.name === "Wedding")?.usualDaysToEdit).toBe(42);
    expect(typesB.find((t) => t.name === "Drone")?.usualDaysToEdit).toBeNull();
    // defaults when no timezone / cause given
    expect((await first(db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, b.organisationId))))?.timezone).toBe(DEFAULT_TIMEZONE);
  });

  it("audits org.created + user.created with the given cause, then every structure step as the owner", async () => {
    const { created } = await createStudio();
    const events = await db.select().from(activityEvents).where(eq(activityEvents.organisationId, created.organisationId)).orderBy(activityEvents.createdAt, activityEvents.rowid);
    const types = events.map((e) => e.eventType);
    expect(types.slice(0, 2)).toEqual(["org.created", "user.created"]);
    expect(types.filter((t) => t === "workflow.created")).toHaveLength(1);
    expect(types.filter((t) => t === "job_type.created")).toHaveLength(DEFAULT_JOB_TYPES.length);
    const orgEvent = events[0];
    expect(orgEvent).toMatchObject({ entityType: "organisation", entityId: created.organisationId, actorUserId: created.ownerId, visibility: "management", newValue: { name: "Northlight Studio", slug: "northlight-studio", timezone: "Australia/Brisbane" } });
    expect(orgEvent.metadata).toMatchObject({ cause: "signup", requestId: "test-signup", ownerUserId: created.ownerId });
    expect(events[1]).toMatchObject({ entityType: "user", entityId: created.ownerId, actorUserId: created.ownerId });
    expect(events[1].metadata).toMatchObject({ cause: "signup", bootstrap: true, primaryOwner: true });
    expect(events.every((e) => e.actorUserId === created.ownerId)).toBe(true);
    expect(events.every((e) => (e.metadata as { cause?: string }).cause === "signup")).toBe(true);
    // the password hash never reaches the ledger
    expect(JSON.stringify(events)).not.toContain(OWNER.passwordHash);
  });

  it("bootstrapOrganisation refuses an owner who is not an active admin of that organisation", async () => {
    const ids = await seedMinimalOrg(db);
    await expect(withTx((tx) => bootstrapOrganisation(tx, { organisationId: ids.organisationId, ownerUserId: ids.users.editor1 }), { db })).rejects.toThrow(/active admin/);
    await expect(withTx((tx) => bootstrapOrganisation(tx, { organisationId: "missing-org", ownerUserId: ids.users.owner }), { db })).rejects.toThrow(/settings row/);
  });

  it("the whole bootstrap is one transaction: a failure leaves no organisation behind", async () => {
    await db.insert(users).values({ organisationId: (await seedMinimalOrg(db, { slug: "x", emailDomain: "x.test" })).organisationId, email: OWNER.email, passwordHash: "h", name: "Taken", role: "editor", createdAt: fakeClock.now(), updatedAt: fakeClock.now() });
    await expect(createStudio({ slug: "fails" })).rejects.toThrow();
    expect(await first(db.select().from(organisations).where(eq(organisations.slug, "fails")))).toBeUndefined();
  });
});

describe("demo seed through the same bootstrap", () => {
  it("the small demo seed runs through createOrganisationWithOwner + bootstrapOrganisation and passes verify", async () => {
    const lines: string[] = [];
    const ok = await seedDatabase(db, { profile: "small", log: (l) => lines.push(l), now: new Date("2026-10-08T00:00:00.000Z") });
    expect(ok).toBe(true);
    const orgs = await db.select().from(organisations);
    expect(orgs.map((o) => o.slug).sort()).toEqual(["northlight", "other-studio"].sort());
    for (const org of orgs) {
      const created = await db.select().from(activityEvents).where(eq(activityEvents.organisationId, org.id));
      expect(created.some((e) => e.eventType === "org.created" && (e.metadata as { cause?: string }).cause === "seed")).toBe(true);
      const owner = await first(db.select().from(users).where(eq(users.id, created.find((e) => e.eventType === "org.created")?.actorUserId ?? "")));
      expect(owner).toMatchObject({ isAdmin: true, role: "photographer" });
      expect(owner?.acceptedAt).not.toBeNull();
      const settings = await first(db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, org.id)));
      expect(settings?.primaryOwnerUserId).toBe(owner?.id);
    }
    // every seeded person signed in with a usable password → accepted
    expect((await db.select().from(users)).every((u) => u.acceptedAt !== null)).toBe(true);
  }, 240_000);
});
