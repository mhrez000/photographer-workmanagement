import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clients, projects, savedViews } from "@/db/schema";
import { addTeamFixture, contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { getAutomationDetail, listAutomationRuns, listAutomations } from "./automations";
import { getClientDetail, listClients } from "./clients";
import { getProjectDetail, listProjects } from "./projects";
import { getNotificationPrefs, getPermissionMatrix, getSettingsView } from "./settings";
import { getTeamDetail, listTeams } from "./teams";
import { directoryStats, getDirectory, getUserDetail, listUsers } from "./users";
import { computeWorkloads, getWorkloads } from "./workloads";
import { getSavedView, listSavedViews } from "./views";
import { getWorkflowGraph, listJobTypes, listWorkflows } from "./workflows";

const NOW = "2026-10-08T00:00:00.000Z";
let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { at: "2026-08-01T00:00:00.000Z" });
  await db.insert(clients).values({ id: "c2", organisationId: ids.organisationId, name: "Bayside Weddings", createdAt: NOW, updatedAt: NOW });
  await db.insert(projects).values({ id: "p2", organisationId: ids.organisationId, clientId: "c2", name: "Smith Wedding", createdAt: NOW, updatedAt: NOW });
  await insertJobFixture(db, ids, { statusKey: "in_progress", dueDate: "2026-10-07T13:00:00.000Z" }); // editor1, overdue
  await insertJobFixture(db, ids, { statusKey: "completed", projectId: "p2", editorId: ids.users.editor2 });
});

afterEach(() => fakeClock.reset());

describe("clients / projects", () => {
  it("management sees every client with org-wide counts", async () => {
    const list = await listClients(db, await contextFor(db, ids.users.manager));
    expect(list.map((c) => c.client.name)).toEqual(["Bayside Weddings", "Harbour Realty"]);
    expect(list[1].counts).toMatchObject({ total: 1, open: 1, overdue: 1 });
    expect(list[0]).toMatchObject({ projectCount: 1, counts: { completed: 1, completedThisMonth: 1 } });
    expect(await listClients(db, await contextFor(db, ids.users.manager), { q: "bay" })).toHaveLength(1);
  });

  it("editors only see clients/projects of their visible jobs; others look missing", async () => {
    const e1 = await contextFor(db, ids.users.editor1);
    expect((await listClients(db, e1)).map((c) => c.client.id)).toEqual([ids.clientId]);
    expect((await listProjects(db, e1)).map((p) => p.project.id)).toEqual([ids.projectId]);
    await expect(getClientDetail(db, e1, "c2")).rejects.toThrow(NotFoundError);
    await expect(getProjectDetail(db, e1, "p2")).rejects.toThrow(NotFoundError);
    const detail = await getClientDetail(db, e1, ids.clientId);
    expect(detail.jobs).toHaveLength(1);
    expect(detail.notes).toBeNull();
    expect((await getProjectDetail(db, await contextFor(db, ids.users.editor2), "p2")).jobs).toHaveLength(1);
  });

  it("foreign ids are 404", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    const owner = await contextFor(db, ids.users.owner);
    await expect(getClientDetail(db, owner, other.clientId)).rejects.toThrow(NotFoundError);
    await expect(getProjectDetail(db, owner, other.projectId)).rejects.toThrow(NotFoundError);
  });
});

describe("users / teams", () => {
  it("reduced projection for photographers and editors; full safe rows for management", async () => {
    const reduced = await listUsers(db, await contextFor(db, ids.users.editor1), { role: "editor" });
    expect(Object.keys(reduced[0]).sort()).toEqual(["avatarColour", "id", "isActive", "name", "role"]);
    const full = await listUsers(db, await contextFor(db, ids.users.owner), { active: "0" });
    expect(full.map((u) => u.id)).toEqual([ids.users.inactiveEditor]);
    expect(full[0]).toHaveProperty("email");
    expect(full[0]).not.toHaveProperty("passwordHash");
    expect(full[0]).not.toHaveProperty("sessionVersion");
  });

  it("directory stats need team workload visibility (own row excepted)", async () => {
    const asEditor = await getDirectory(db, await contextFor(db, ids.users.editor1), "editor");
    expect(asEditor.map((e) => e.user.id).sort()).toEqual([ids.users.editor1, ids.users.editor2].sort());
    expect(asEditor.find((e) => e.user.id === ids.users.editor2)?.stats).toBeNull();
    expect(asEditor.find((e) => e.user.id === ids.users.editor1)?.stats).toMatchObject({ active: 1, overdue: 1 });
    expect(asEditor.find((e) => e.user.id === ids.users.editor2)?.email).toBeNull();
    const asOwner = await getDirectory(db, await contextFor(db, ids.users.owner), "editor");
    expect(asOwner).toHaveLength(3); // includes the inactive editor
    expect(asOwner.find((e) => e.user.id === ids.users.editor2)?.stats).toMatchObject({ completedThisMonth: 1 });
  });

  it("user detail: profile + workload for management/self, reduced for others", async () => {
    const m = await getUserDetail(db, await contextFor(db, ids.users.manager), ids.users.editor1);
    expect(m.profile?.email).toBe("editor01@studio.test");
    expect(m.workload?.active).toBe(1);
    expect(m.canManage).toBe(true);
    const p = await getUserDetail(db, await contextFor(db, ids.users.photographer1), ids.users.editor1);
    expect(p.profile).toBeNull();
    expect(p.workload).toBeNull();
    expect(p.canManage).toBe(false);
  });

  it("teams: members for everyone, membership ledger for team.manage", async () => {
    const { teamId } = await addTeamFixture(db, ids, {
      name: "Real Estate Crew",
      memberIds: [ids.users.editor1, ids.users.photographer1],
      leadUserId: ids.users.photographer1,
    });
    await addTeamFixture(db, ids, { name: "Old", memberIds: [], archived: true });
    const asEditor = await contextFor(db, ids.users.editor1);
    expect((await listTeams(db, asEditor, { includeArchived: "1" })).map((t) => t.name)).toEqual(["Real Estate Crew"]);
    expect(await listTeams(db, await contextFor(db, ids.users.owner), { includeArchived: "1" })).toHaveLength(2);
    expect(await getTeamDetail(db, asEditor, teamId)).toMatchObject({ memberCount: 2, memberships: [] });
    expect((await getTeamDetail(db, await contextFor(db, ids.users.manager), teamId)).memberships).toHaveLength(2);
  });
});

describe("settings / workflows / automations / views", () => {
  it("settings and the roles matrix are O/M only; prefs default to enabled", async () => {
    expect(await getSettingsView(db, await contextFor(db, ids.users.owner))).toMatchObject({ canManage: true, organisation: { slug: "studio" } });
    expect((await getSettingsView(db, await contextFor(db, ids.users.manager))).canManage).toBe(false);
    await expect(getSettingsView(db, await contextFor(db, ids.users.editor1))).rejects.toThrow(ForbiddenError);
    expect(getPermissionMatrix(await contextFor(db, ids.users.manager)).length).toBeGreaterThan(50);
    const prefs = await getNotificationPrefs(db, await contextFor(db, ids.users.editor1));
    expect(prefs.every((p) => p.enabled)).toBe(true);
  });

  it("workflow graph lists statuses with job counts and validates clean", async () => {
    const ctx = await contextFor(db, ids.users.manager);
    expect((await listWorkflows(db, ctx))[0]).toMatchObject({ isDefault: true, statusCount: 13, openJobCount: 1 });
    const g = await getWorkflowGraph(db, ctx, ids.workflowId);
    expect(g.statuses).toHaveLength(13);
    expect(g.statuses.find((s) => s.key === "in_progress")?.jobCount).toBe(1);
    expect(g.transitions.some((t) => t.generated)).toBe(false); // seeded cancel edges exist
    expect(g.validation).toEqual([]);
    await expect(getWorkflowGraph(db, await contextFor(db, ids.users.photographer1), ids.workflowId)).rejects.toThrow(ForbiddenError);
    expect((await listJobTypes(db, await contextFor(db, ids.users.photographer1))).length).toBe(10);
  });

  it("automations and runs are management-only; empty org lists cleanly", async () => {
    expect(await listAutomations(db, await contextFor(db, ids.users.manager))).toEqual([]);
    expect(await listAutomationRuns(db, await contextFor(db, ids.users.owner))).toEqual({ items: [], nextCursor: null });
    await expect(listAutomations(db, await contextFor(db, ids.users.editor1))).rejects.toThrow(ForbiddenError);
    await expect(getAutomationDetail(db, await contextFor(db, ids.users.manager), "nope")).rejects.toThrow(NotFoundError);
  });

  it("saved views: own + shared; someone else's private view is 404", async () => {
    const config = { filters: { quick: "overdue" }, sort: [], columns: ["job" as const] };
    await db.insert(savedViews).values([
      { id: "v1", organisationId: ids.organisationId, ownerUserId: ids.users.editor1, name: "Mine", scope: "all_work", config },
      { id: "v2", organisationId: ids.organisationId, ownerUserId: ids.users.manager, name: "Overdue", scope: "all_work", config, isShared: true },
      { id: "v3", organisationId: ids.organisationId, ownerUserId: ids.users.manager, name: "Private", scope: "all_work", config },
    ]);
    const ctx = await contextFor(db, ids.users.editor1);
    expect((await listSavedViews(db, ctx, { scope: "all_work" })).map((v) => [v.id, v.isMine])).toEqual([
      ["v1", true],
      ["v2", false],
    ]);
    expect((await getSavedView(db, ctx, "v2")).config.filters.quick).toBe("overdue");
    await expect(getSavedView(db, ctx, "v3")).rejects.toThrow(NotFoundError);
  });
});

describe("editor directory stats = workload rows", () => {
  it("active / dueToday / overdue match computeWorkloads even when the editor holds approved or delivered jobs", async () => {
    const e1 = ids.users.editor1;
    await insertJobFixture(db, ids, { statusKey: "submitted", editorId: e1 });
    await insertJobFixture(db, ids, { statusKey: "approved", editorId: e1 });
    await insertJobFixture(db, ids, { statusKey: "delivered", editorId: e1 });
    await insertJobFixture(db, ids, { statusKey: "accepted", editorId: ids.users.editor2, dueDate: "2026-10-08T12:59:59.999Z" });
    const ctx = await contextFor(db, ids.users.manager);
    const editorIds = [e1, ids.users.editor2];
    const stats = await directoryStats(db, ctx, "editor", editorIds);
    const rows = new Map((await computeWorkloads(db, ctx)).rows.map((r) => [r.editor.id, r]));
    for (const id of editorIds) {
      const row = rows.get(id);
      expect(stats.get(id)?.active).toBe(row?.active);
      expect(stats.get(id)?.dueToday).toBe(row?.dueToday);
      expect(stats.get(id)?.overdue).toBe(row?.overdue);
    }
    expect(stats.get(e1)?.active).toBe(2); // in_progress + submitted; approved / delivered are not held
    // the /team/editors directory and /api/workloads agree
    const dir = new Map((await getDirectory(db, ctx, "editor")).map((d) => [d.user.id, d.stats]));
    for (const w of await getWorkloads(db, ctx)) if (dir.has(w.editor.id)) expect(dir.get(w.editor.id)?.active).toBe(w.active);
    // and /team/users/[id] (WorkloadDetail) shows the same Active
    expect((await getUserDetail(db, ctx, e1)).workload?.active).toBe(2);
  });
});
