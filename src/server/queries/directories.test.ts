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

beforeEach(() => {
  fakeClock.set(NOW);
  db = makeTestDb();
  ids = seedMinimalOrg(db, { at: "2026-08-01T00:00:00.000Z" });
  db.insert(clients).values({ id: "c2", organisationId: ids.organisationId, name: "Bayside Weddings", createdAt: NOW, updatedAt: NOW }).run();
  db.insert(projects).values({ id: "p2", organisationId: ids.organisationId, clientId: "c2", name: "Smith Wedding", createdAt: NOW, updatedAt: NOW }).run();
  insertJobFixture(db, ids, { statusKey: "in_progress", dueDate: "2026-10-07T13:00:00.000Z" }); // editor1, overdue
  insertJobFixture(db, ids, { statusKey: "completed", projectId: "p2", editorId: ids.users.editor2 });
});

afterEach(() => fakeClock.reset());

describe("clients / projects", () => {
  it("management sees every client with org-wide counts", () => {
    const list = listClients(db, contextFor(db, ids.users.manager));
    expect(list.map((c) => c.client.name)).toEqual(["Bayside Weddings", "Harbour Realty"]);
    expect(list[1].counts).toMatchObject({ total: 1, open: 1, overdue: 1 });
    expect(list[0]).toMatchObject({ projectCount: 1, counts: { completed: 1, completedThisMonth: 1 } });
    expect(listClients(db, contextFor(db, ids.users.manager), { q: "bay" })).toHaveLength(1);
  });

  it("editors only see clients/projects of their visible jobs; others look missing", () => {
    const e1 = contextFor(db, ids.users.editor1);
    expect(listClients(db, e1).map((c) => c.client.id)).toEqual([ids.clientId]);
    expect(listProjects(db, e1).map((p) => p.project.id)).toEqual([ids.projectId]);
    expect(() => getClientDetail(db, e1, "c2")).toThrow(NotFoundError);
    expect(() => getProjectDetail(db, e1, "p2")).toThrow(NotFoundError);
    const detail = getClientDetail(db, e1, ids.clientId);
    expect(detail.jobs).toHaveLength(1);
    expect(detail.notes).toBeNull();
    expect(getProjectDetail(db, contextFor(db, ids.users.editor2), "p2").jobs).toHaveLength(1);
  });

  it("foreign ids are 404", () => {
    const other = seedMinimalOrg(db, { slug: "other" });
    expect(() => getClientDetail(db, contextFor(db, ids.users.owner), other.clientId)).toThrow(NotFoundError);
    expect(() => getProjectDetail(db, contextFor(db, ids.users.owner), other.projectId)).toThrow(NotFoundError);
  });
});

describe("users / teams", () => {
  it("reduced projection for photographers and editors; full safe rows for management", () => {
    const reduced = listUsers(db, contextFor(db, ids.users.editor1), { role: "editor" });
    expect(Object.keys(reduced[0]).sort()).toEqual(["avatarColour", "id", "isActive", "name", "role"]);
    const full = listUsers(db, contextFor(db, ids.users.owner), { active: "0" });
    expect(full.map((u) => u.id)).toEqual([ids.users.inactiveEditor]);
    expect(full[0]).toHaveProperty("email");
    expect(full[0]).not.toHaveProperty("passwordHash");
    expect(full[0]).not.toHaveProperty("sessionVersion");
  });

  it("directory stats need team workload visibility (own row excepted)", () => {
    const asEditor = getDirectory(db, contextFor(db, ids.users.editor1), "editor");
    expect(asEditor.map((e) => e.user.id).sort()).toEqual([ids.users.editor1, ids.users.editor2].sort());
    expect(asEditor.find((e) => e.user.id === ids.users.editor2)?.stats).toBeNull();
    expect(asEditor.find((e) => e.user.id === ids.users.editor1)?.stats).toMatchObject({ active: 1, overdue: 1 });
    expect(asEditor.find((e) => e.user.id === ids.users.editor2)?.email).toBeNull();
    const asOwner = getDirectory(db, contextFor(db, ids.users.owner), "editor");
    expect(asOwner).toHaveLength(3); // includes the inactive editor
    expect(asOwner.find((e) => e.user.id === ids.users.editor2)?.stats).toMatchObject({ completedThisMonth: 1 });
  });

  it("user detail: profile + workload for management/self, reduced for others", () => {
    const m = getUserDetail(db, contextFor(db, ids.users.manager), ids.users.editor1);
    expect(m.profile?.email).toBe("editor01@studio.test");
    expect(m.workload?.active).toBe(1);
    expect(m.canManage).toBe(true);
    const p = getUserDetail(db, contextFor(db, ids.users.photographer1), ids.users.editor1);
    expect(p.profile).toBeNull();
    expect(p.workload).toBeNull();
    expect(p.canManage).toBe(false);
  });

  it("teams: members for everyone, membership ledger for team.manage", () => {
    const { teamId } = addTeamFixture(db, ids, { name: "Real Estate Crew", memberIds: [ids.users.editor1, ids.users.photographer1], leadUserId: ids.users.photographer1 });
    addTeamFixture(db, ids, { name: "Old", memberIds: [], archived: true });
    const asEditor = contextFor(db, ids.users.editor1);
    expect(listTeams(db, asEditor, { includeArchived: "1" }).map((t) => t.name)).toEqual(["Real Estate Crew"]);
    expect(listTeams(db, contextFor(db, ids.users.owner), { includeArchived: "1" })).toHaveLength(2);
    expect(getTeamDetail(db, asEditor, teamId)).toMatchObject({ memberCount: 2, memberships: [] });
    expect(getTeamDetail(db, contextFor(db, ids.users.manager), teamId).memberships).toHaveLength(2);
  });
});

describe("settings / workflows / automations / views", () => {
  it("settings and the roles matrix are O/M only; prefs default to enabled", () => {
    expect(getSettingsView(db, contextFor(db, ids.users.owner))).toMatchObject({ canManage: true, organisation: { slug: "studio" } });
    expect(getSettingsView(db, contextFor(db, ids.users.manager)).canManage).toBe(false);
    expect(() => getSettingsView(db, contextFor(db, ids.users.editor1))).toThrow(ForbiddenError);
    expect(getPermissionMatrix(contextFor(db, ids.users.manager)).length).toBeGreaterThan(50);
    const prefs = getNotificationPrefs(db, contextFor(db, ids.users.editor1));
    expect(prefs.every((p) => p.enabled)).toBe(true);
  });

  it("workflow graph lists statuses with job counts and validates clean", () => {
    const ctx = contextFor(db, ids.users.manager);
    expect(listWorkflows(db, ctx)[0]).toMatchObject({ isDefault: true, statusCount: 13, openJobCount: 1 });
    const g = getWorkflowGraph(db, ctx, ids.workflowId);
    expect(g.statuses).toHaveLength(13);
    expect(g.statuses.find((s) => s.key === "in_progress")?.jobCount).toBe(1);
    expect(g.transitions.some((t) => t.generated)).toBe(false); // seeded cancel edges exist
    expect(g.validation).toEqual([]);
    expect(() => getWorkflowGraph(db, contextFor(db, ids.users.photographer1), ids.workflowId)).toThrow(ForbiddenError);
    expect(listJobTypes(db, contextFor(db, ids.users.photographer1)).length).toBe(10);
  });

  it("automations and runs are management-only; empty org lists cleanly", () => {
    expect(listAutomations(db, contextFor(db, ids.users.manager))).toEqual([]);
    expect(listAutomationRuns(db, contextFor(db, ids.users.owner))).toEqual({ items: [], nextCursor: null });
    expect(() => listAutomations(db, contextFor(db, ids.users.editor1))).toThrow(ForbiddenError);
    expect(() => getAutomationDetail(db, contextFor(db, ids.users.manager), "nope")).toThrow(NotFoundError);
  });

  it("saved views: own + shared; someone else's private view is 404", () => {
    const config = { filters: { quick: "overdue" }, sort: [], columns: ["job" as const] };
    db.insert(savedViews)
      .values([
        { id: "v1", organisationId: ids.organisationId, ownerUserId: ids.users.editor1, name: "Mine", scope: "all_work", config },
        { id: "v2", organisationId: ids.organisationId, ownerUserId: ids.users.manager, name: "Overdue", scope: "all_work", config, isShared: true },
        { id: "v3", organisationId: ids.organisationId, ownerUserId: ids.users.manager, name: "Private", scope: "all_work", config },
      ])
      .run();
    const ctx = contextFor(db, ids.users.editor1);
    expect(listSavedViews(db, ctx, { scope: "all_work" }).map((v) => [v.id, v.isMine])).toEqual([
      ["v1", true],
      ["v2", false],
    ]);
    expect(getSavedView(db, ctx, "v2").config.filters.quick).toBe("overdue");
    expect(() => getSavedView(db, ctx, "v3")).toThrow(NotFoundError);
  });
});

describe("editor directory stats = workload rows", () => {
  it("active / dueToday / overdue match computeWorkloads even when the editor holds approved or delivered jobs", () => {
    const e1 = ids.users.editor1;
    insertJobFixture(db, ids, { statusKey: "submitted", editorId: e1 });
    insertJobFixture(db, ids, { statusKey: "approved", editorId: e1 });
    insertJobFixture(db, ids, { statusKey: "delivered", editorId: e1 });
    insertJobFixture(db, ids, { statusKey: "accepted", editorId: ids.users.editor2, dueDate: "2026-10-08T12:59:59.999Z" });
    const ctx = contextFor(db, ids.users.manager);
    const editorIds = [e1, ids.users.editor2];
    const stats = directoryStats(db, ctx, "editor", editorIds);
    const rows = new Map(computeWorkloads(db, ctx).rows.map((r) => [r.editor.id, r]));
    for (const id of editorIds) {
      const row = rows.get(id);
      expect(stats.get(id)?.active).toBe(row?.active);
      expect(stats.get(id)?.dueToday).toBe(row?.dueToday);
      expect(stats.get(id)?.overdue).toBe(row?.overdue);
    }
    expect(stats.get(e1)?.active).toBe(2); // in_progress + submitted; approved / delivered are not held
    // the /team/editors directory and /api/workloads agree
    const dir = new Map(getDirectory(db, ctx, "editor").map((d) => [d.user.id, d.stats]));
    for (const w of getWorkloads(db, ctx)) if (dir.has(w.editor.id)) expect(dir.get(w.editor.id)?.active).toBe(w.active);
    // and /team/users/[id] (WorkloadDetail) shows the same Active
    expect(getUserDetail(db, ctx, e1).workload?.active).toBe(2);
  });
});
