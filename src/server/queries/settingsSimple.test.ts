import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automations, organisationSettings } from "@/db/schema";
import { contextFor, fakeClock, insertDefaultWorkflow, insertJobFixture, makeTestDb, seedMinimalOrg, setUserFlags, type SeedIds, type TestDb } from "@/db/test-db";
import { ForbiddenError } from "@/server/errors";
import { getAdvancedState, getPeopleOverview, getStudioHistory, photographerPreset } from "./settingsSimple";

const NOW = "2026-10-08T00:00:00.000Z";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const ctxOf = async (key: keyof SeedIds["users"]) => await contextFor(db, ids.users[key]);

describe("photographerPreset", () => {
  const own = { isAdmin: false, canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: true, canViewTeamWorkloads: false, canViewAllJobs: false, canViewAnalytics: false };
  it("maps the six switches to the invite choice", () => {
    expect(photographerPreset(own)).toBe("own_shoots");
    expect(photographerPreset({ ...own, isAdmin: true })).toBe("everything");
    expect(photographerPreset({ ...own, canViewAllJobs: true })).toBe("custom");
    expect(photographerPreset({ ...own, canReviewSubmissions: false })).toBe("custom"); // junior: the owner reviews
    expect(photographerPreset({ isAdmin: false })).toBe("custom");
  });
});

describe("getPeopleOverview", () => {
  it("three plain cards with presets, Can add their own jobs and the portal count", async () => {
    await setUserFlags(db, ids.users.editor2, { canCreateJobs: false });
    const people = await getPeopleOverview(db, await ctxOf("owner"));
    expect(people.owners.map((c) => [c.user.name, c.preset, c.isPrimaryOwner, c.email])).toEqual([
      ["Cora Co-Admin", "everything", false, ids.emails.coAdmin],
      ["Olivia Owner", "everything", true, ids.emails.owner],
    ]);
    expect(people.photographers.map((c) => [c.user.name, c.preset])).toEqual([
      ["Leo Lead", "custom"],
      ["Paul Photographer", "own_shoots"],
      ["Pia Photographer", "own_shoots"],
    ]);
    expect(people.editors.map((c) => [c.user.name, c.canCreateJobs, c.user.isActive, c.preset, c.usualCapacity])).toEqual([
      ["Ed Editor", false, true, null, null],
      ["Eve Editor", true, true, null, null],
      ["Iris Inactive", true, false, null, null],
    ]);
    expect(people.clients).toEqual({ withPortal: 2, total: 2 });
  });

  it("is owner-only", async () => {
    await expect(getPeopleOverview(db, await ctxOf("lead"))).rejects.toThrow(ForbiddenError);
    await expect(getPeopleOverview(db, await ctxOf("editor1"))).rejects.toThrow(ForbiddenError);
    await expect(getPeopleOverview(db, await ctxOf("client"))).rejects.toThrow(ForbiddenError);
  });
});

describe("getStudioHistory", () => {
  it("is the studio-wide feed for the owner; members and editors get 403", async () => {
    await insertJobFixture(db, ids, { statusKey: "new" });
    await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const feed = await getStudioHistory(db, await ctxOf("owner"), { limit: "10" });
    expect(feed.items.map((i) => i.eventType)).toEqual(["job.created", "job.created"]);
    await expect(getStudioHistory(db, await ctxOf("photographer1"))).rejects.toThrow(ForbiddenError);
    await expect(getStudioHistory(db, await ctxOf("editor1"))).rejects.toThrow(ForbiddenError);
  });
});

describe("getAdvancedState", () => {
  it("is off by default and reads the switch (migration 0004)", async () => {
    const owner = await ctxOf("owner");
    expect(await getAdvancedState(db, owner)).toEqual({ enabled: false, columnPresent: true, forcedOn: false, forcedReasons: [], effective: false, canManage: true });
    await db.update(organisationSettings).set({ advancedToolsEnabled: true }).where(eq(organisationSettings.organisationId, ids.organisationId));
    expect(await getAdvancedState(db, owner)).toMatchObject({ enabled: true, effective: true });
    expect((await getAdvancedState(db, await ctxOf("coAdmin"))).canManage).toBe(true);
  });

  it("is forced on for a studio with custom workflows or live automations", async () => {
    const owner = await ctxOf("owner");
    await insertDefaultWorkflow(db, ids.organisationId, { idPrefix: "custom", name: "Video", isDefault: false, createdByUserId: ids.users.owner });
    expect(await getAdvancedState(db, owner)).toMatchObject({ enabled: false, forcedOn: true, forcedReasons: ["custom_workflows"], effective: true });
    await db.insert(automations).values({
      organisationId: ids.organisationId,
      name: "Nudge",
      triggerType: "job_created",
      trigger: { type: "job_created" },
      actions: [{ type: "notify", target: "admins" }],
      createdByUserId: ids.users.owner,
    });
    expect((await getAdvancedState(db, owner)).forcedReasons).toEqual(["custom_workflows", "automations"]);
    await expect(getAdvancedState(db, await ctxOf("lead"))).rejects.toThrow(ForbiddenError);
  });
});
