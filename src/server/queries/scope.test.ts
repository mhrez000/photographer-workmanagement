/**
 * Read-side scoping helpers (docs/ROLES.md §2.3 cut-off, §8 view scope,
 * needsAdminReviewWhere) and the client guard on the shared metric scope.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { jobs } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, inviteDefaultsMember, makeTestDb, seedMinimalOrg, setUserFlags, type SeedIds, type TestDb } from "@/db/test-db";
import type { JobPermissionRef } from "@/lib/types";
import { ForbiddenError } from "@/server/errors";
import { jobCountsBy, kpisFor, loadMetricJobs } from "./metrics";
import { getPerformance } from "./performance";
import { assertStaffRead, editorReadCutoff, needsAdminReviewWhere, passesCutoff, redactOtherEditor, viewScopeFor } from "./scope";

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

function ref(over: Partial<JobPermissionRef>): JobPermissionRef {
  return {
    id: "j",
    organisationId: ids.organisationId,
    photographerId: ids.users.photographer1,
    editorId: null,
    createdByUserId: ids.users.photographer1,
    createdByRole: "photographer",
    statusCategory: "in_progress",
    isPaused: false,
    draftClosed: true,
    clientId: ids.clientId,
    sharedWithClient: false,
    projectSharedWithClient: false,
    ...over,
  };
}

describe("viewScopeFor", () => {
  it("holders: param beats cookie, 'all' = business, default business; non-holders always null", async () => {
    const owner = await ctxOf("owner");
    expect(viewScopeFor(owner)).toBe("business");
    expect(viewScopeFor(owner, { scopeCookie: "mine" })).toBe("mine");
    expect(viewScopeFor(owner, { scope: "business", scopeCookie: "mine" })).toBe("business");
    expect(viewScopeFor(owner, { scope: "all", scopeCookie: "mine" })).toBe("business");
    expect(viewScopeFor(owner, { scope: "nonsense", scopeCookie: "mine" })).toBe("mine");
    expect(viewScopeFor(await ctxOf("lead"), { scope: "mine" })).toBe("mine");
    for (const key of ["photographer1", "editor1", "client"] as const) {
      expect(viewScopeFor(await ctxOf(key), { scope: "mine", scopeCookie: "business" })).toBeNull();
    }
  });
});

describe("editor read cut-off", () => {
  it("past: latest unassignment of my rows; created: the first other editor's assignment; assigned / teamView: none", async () => {
    const e1 = await ctxOf("editor1");
    const me = ids.users.editor1;
    const other = ids.users.editor2;
    const past = [
      { userId: me, assignedAt: "2026-10-01T00:00:00.000Z", unassignedAt: "2026-10-02T00:00:00.000Z" },
      { userId: other, assignedAt: "2026-10-02T00:00:00.000Z", unassignedAt: null },
    ];
    expect(editorReadCutoff(e1, ref({ editorId: other, pastEditorIds: [me, other] }), past)).toBe("2026-10-02T00:00:00.000Z");
    const created = [{ userId: other, assignedAt: "2026-10-03T00:00:00.000Z", unassignedAt: null }];
    expect(editorReadCutoff(e1, ref({ editorId: other, createdByUserId: me, createdByRole: "editor" }), created)).toBe("2026-10-03T00:00:00.000Z");
    expect(editorReadCutoff(e1, ref({ editorId: null, createdByUserId: me, createdByRole: "editor" }), [])).toBeNull();
    expect(editorReadCutoff(e1, ref({ editorId: me }), past)).toBeNull();
    await setUserFlags(db, me, { canViewTeamJobs: true });
    expect(editorReadCutoff(await ctxOf("editor1"), ref({ editorId: other }), past)).toBeNull();
    // non-editors never have a cut-off
    expect(editorReadCutoff(await ctxOf("photographer1"), ref({ editorId: other }), past)).toBeNull();
    expect(passesCutoff("2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z", me, me)).toBe(true);
    expect(passesCutoff("2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z", other, me)).toBe(false);
    expect(passesCutoff(null, "2030-01-01T00:00:00.000Z", other, me)).toBe(true);
  });

  it("another editor's identity is hidden only from editors without the team switch", async () => {
    const r = { id: ids.users.editor2, name: "Ed Editor", role: "editor" as const, avatarColour: "#000", isActive: true };
    expect(redactOtherEditor(await ctxOf("editor1"), r)?.name).toBe("Another editor");
    expect(redactOtherEditor(await ctxOf("editor2"), r)?.name).toBe("Ed Editor");
    expect(redactOtherEditor(await ctxOf("owner"), r)?.name).toBe("Ed Editor");
    await setUserFlags(db, ids.users.editor1, { canViewTeamJobs: true });
    expect(redactOtherEditor(await ctxOf("editor1"), r)?.name).toBe("Ed Editor");
  });
});

describe("needsAdminReviewWhere", () => {
  it("jobs whose managing photographers cannot review (juniors, editor-created with such a photographer)", async () => {
    const junior = await inviteDefaultsMember(db, ids);
    const juniorJob = (await insertJobFixture(db, ids, { statusKey: "submitted", photographerId: junior, createdByUserId: junior })).job;
    const editorMadeForJunior = (await insertJobFixture(db, ids, { statusKey: "submitted", photographerId: junior, createdByUserId: ids.users.editor1 })).job;
    const p1Job = (await insertJobFixture(db, ids, { statusKey: "submitted" })).job; // photographer1 reviews
    const ownerJob = (await insertJobFixture(db, ids, { statusKey: "submitted", photographerId: ids.users.owner, createdByUserId: ids.users.owner })).job;
    const noPhotographer = (await insertJobFixture(db, ids, { statusKey: "submitted", photographerId: null, createdByUserId: ids.users.editor1 })).job;
    const rows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.organisationId, ids.organisationId), needsAdminReviewWhere()));
    const hit = new Set(rows.map((r) => r.id));
    expect(hit.has(juniorJob.id)).toBe(true);
    expect(hit.has(editorMadeForJunior.id)).toBe(true);
    expect(hit.has(noPhotographer.id)).toBe(true);
    expect(hit.has(p1Job.id)).toBe(false);
    expect(hit.has(ownerJob.id)).toBe(false); // an admin's own shoot: they review it themselves
  });
});

describe("client isolation on shared read helpers", () => {
  it("assertStaffRead, org-scope metrics and performance never serve a client context", async () => {
    await insertJobFixture(db, ids, { statusKey: "in_progress", sharedWithClient: true });
    const client = await ctxOf("client");
    expect(() => assertStaffRead(client)).toThrow(ForbiddenError);
    expect(() => assertStaffRead({ ...client, isSystem: true })).not.toThrow();
    expect(await loadMetricJobs(db, client, { scope: "org" })).toEqual([]);
    expect(await loadMetricJobs(db, client, { scope: "visible" })).toEqual([]);
    expect((await jobCountsBy(db, client, "clientId", { scope: "org" })).size).toBe(0);
    expect((await kpisFor(db, client, { scope: "org" })).active).toBe(0);
    await expect(getPerformance(db, client)).rejects.toThrow(ForbiddenError);
    // staff still get the org scope
    expect(await loadMetricJobs(db, await ctxOf("owner"), { scope: "org" })).toHaveLength(1);
  });
});
