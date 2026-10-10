import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clients, projects, savedViews } from "@/db/schema";
import { eq } from "drizzle-orm";
import { addTeamFixture, contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, setUserFlags, type SeedIds, type TestDb } from "@/db/test-db";
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
  it("admins see every client with org-wide counts", async () => {
    const list = await listClients(db, await contextFor(db, ids.users.coAdmin));
    expect(list.map((c) => c.client.name)).toEqual(["Bayside Weddings", "Coastal Key Property", "Harbour Realty"]);
    expect(list[2].counts).toMatchObject({ total: 1, open: 1, overdue: 1 });
    expect(list[2].client).toMatchObject({ portalEnabled: true, feedbackEnabled: true });
    expect(list[0]).toMatchObject({ projectCount: 1, counts: { completed: 1, completedThisMonth: 1 } });
    expect(await listClients(db, await contextFor(db, ids.users.coAdmin), { q: "bay" })).toHaveLength(1);
  });

  it("editors never see client contact details or notes; their q matches the name only (§2.4)", async () => {
    await db.update(clients).set({ contactName: "Sarah K", email: "sarah@harbour.example", phone: "0400 000 000", notes: "pays late" }).where(eq(clients.id, ids.clientId));
    const e1 = await contextFor(db, ids.users.editor1);
    const [row] = await listClients(db, e1);
    expect(row.client).toMatchObject({ id: ids.clientId, name: "Harbour Realty", contactName: null, email: null, phone: null });
    expect(await listClients(db, e1, { q: "sarah" })).toEqual([]);
    expect(await listClients(db, e1, { q: "harbour" })).toHaveLength(1);
    const detail = await getClientDetail(db, e1, ids.clientId);
    expect(detail.client).toMatchObject({ contactName: null, email: null, phone: null });
    expect(detail.notes).toBeNull();
    // team members and admins keep the contact details and notes
    const p1 = await getClientDetail(db, await contextFor(db, ids.users.photographer1), ids.clientId);
    expect(p1.client.email).toBe("sarah@harbour.example");
    expect(p1.notes).toBe("pays late");
    expect((await listClients(db, await contextFor(db, ids.users.owner), { q: "sarah" })).map((c) => c.client.id)).toEqual([ids.clientId]);
  });

  it("clients (portal users) get 403 on every staff client / project read", async () => {
    const client = await contextFor(db, ids.users.client);
    await expect(listClients(db, client)).rejects.toThrow(ForbiddenError);
    await expect(getClientDetail(db, client, ids.clientId)).rejects.toThrow(ForbiddenError);
    await expect(listProjects(db, client)).rejects.toThrow(ForbiddenError);
    await expect(getProjectDetail(db, client, ids.projectId)).rejects.toThrow(ForbiddenError);
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
  it("reduced projection for team members and editors; full safe rows for admins", async () => {
    const reduced = await listUsers(db, await contextFor(db, ids.users.editor1), { role: "editor" });
    expect(Object.keys(reduced.find((u) => u.id === ids.users.editor2) ?? {}).sort()).toEqual(["avatarColour", "id", "isActive", "isAdmin", "isPrimaryOwner", "name", "role", "title"]);
    const everyone = await listUsers(db, await contextFor(db, ids.users.photographer1));
    expect(everyone.some((u) => u.role === "client")).toBe(false);
    expect(everyone.find((u) => u.id === ids.users.owner)).toMatchObject({ isAdmin: true, isPrimaryOwner: true });
    expect(everyone.find((u) => u.id === ids.users.owner)).not.toHaveProperty("email");
    // ?role=client is a 400 for non-admins; email search is admin-only
    await expect(listUsers(db, await contextFor(db, ids.users.photographer1), { role: "client" })).rejects.toThrow(/Invalid|role/i);
    expect(await listUsers(db, await contextFor(db, ids.users.editor1), { q: "owner@studio" })).toEqual([]);
    expect((await listUsers(db, await contextFor(db, ids.users.owner), { q: "owner@studio" })).map((u) => u.id)).toEqual([ids.users.owner]);
    expect((await listUsers(db, await contextFor(db, ids.users.owner), { role: "client" })).map((u) => u.id).sort()).toEqual([ids.users.client, ids.users.client2].sort());
    await expect(listUsers(db, await contextFor(db, ids.users.client))).rejects.toThrow(ForbiddenError);
    const full = await listUsers(db, await contextFor(db, ids.users.owner), { active: "0" });
    expect(full.map((u) => u.id)).toEqual([ids.users.inactiveEditor]);
    expect(full[0]).toHaveProperty("email");
    expect(full[0]).not.toHaveProperty("passwordHash");
    expect(full[0]).not.toHaveProperty("sessionVersion");
  });

  it("directories: admins and members only; stats follow §10.2 (workloads for editor counts, analytics for rates and peers)", async () => {
    await expect(getDirectory(db, await contextFor(db, ids.users.editor1), "editor")).rejects.toThrow(ForbiddenError);
    await expect(getDirectory(db, await contextFor(db, ids.users.client), "photographer")).rejects.toThrow(ForbiddenError);
    const plain = await getDirectory(db, await contextFor(db, ids.users.photographer1), "editor");
    expect(plain.map((e) => e.user.id).sort()).toEqual([ids.users.editor1, ids.users.editor2].sort());
    expect(plain.every((e) => e.stats === null && e.email === null)).toBe(true);
    await setUserFlags(db, ids.users.photographer1, { canViewTeamWorkloads: true });
    const withWorkloads = await getDirectory(db, await contextFor(db, ids.users.photographer1), "editor");
    expect(withWorkloads.find((e) => e.user.id === ids.users.editor1)?.stats).toMatchObject({ active: 1, overdue: 1, completedThisMonth: null, revisionRate: null });
    // photographer peers: own row only without analytics
    const peers = await getDirectory(db, await contextFor(db, ids.users.photographer1), "photographer");
    expect(peers.find((e) => e.user.id === ids.users.photographer2)?.stats).toBeNull();
    expect(peers.find((e) => e.user.id === ids.users.photographer1)?.stats).toMatchObject({ active: 1 });
    expect(peers.find((e) => e.user.id === ids.users.owner)?.user).toMatchObject({ isAdmin: true, isPrimaryOwner: true });
    await setUserFlags(db, ids.users.photographer1, { canViewAnalytics: true });
    const analytics = await getDirectory(db, await contextFor(db, ids.users.photographer1), "editor");
    expect(analytics.find((e) => e.user.id === ids.users.editor2)?.stats).toMatchObject({ completedThisMonth: 1 });
    const asOwner = await getDirectory(db, await contextFor(db, ids.users.owner), "editor");
    expect(asOwner).toHaveLength(3); // includes the inactive editor
    expect(asOwner.find((e) => e.user.id === ids.users.editor2)?.stats).toMatchObject({ completedThisMonth: 1 });
    expect(asOwner.find((e) => e.user.id === ids.users.editor2)?.email).toBe("editor02@studio.test");
  });

  it("user detail: profile for admins/self, person-page workload rule, client ids 404 for non-admins", async () => {
    const m = await getUserDetail(db, await contextFor(db, ids.users.coAdmin), ids.users.editor1);
    expect(m.profile?.email).toBe("editor01@studio.test");
    expect(m.workload?.active).toBe(1);
    expect(m.canManage).toBe(true);
    // a co-admin cannot manage the primary owner
    expect((await getUserDetail(db, await contextFor(db, ids.users.coAdmin), ids.users.owner)).canManage).toBe(false);
    const p = await getUserDetail(db, await contextFor(db, ids.users.photographer1), ids.users.editor1);
    expect(p.profile).toBeNull();
    expect(p.workload).toBeNull();
    expect(p.canManage).toBe(false);
    await setUserFlags(db, ids.users.photographer1, { canViewTeamWorkloads: true });
    expect((await getUserDetail(db, await contextFor(db, ids.users.photographer1), ids.users.editor1)).workload?.active).toBe(1);
    // editors never open another person's page; their own is fine
    expect((await getUserDetail(db, await contextFor(db, ids.users.editor2), ids.users.editor1)).workload).toBeNull();
    expect((await getUserDetail(db, await contextFor(db, ids.users.editor1), ids.users.editor1)).workload?.active).toBe(1);
    await expect(getUserDetail(db, await contextFor(db, ids.users.photographer1), ids.users.client)).rejects.toThrow(NotFoundError);
    await expect(getUserDetail(db, await contextFor(db, ids.users.editor1), ids.users.client)).rejects.toThrow(NotFoundError);
    expect((await getUserDetail(db, await contextFor(db, ids.users.owner), ids.users.client)).profile?.email).toBe("client@studio.test");
    await expect(getUserDetail(db, await contextFor(db, ids.users.client), ids.users.client)).rejects.toThrow(ForbiddenError);
  });

  it("teams: members for admins and team members, membership ledger for team.manage", async () => {
    const { teamId } = await addTeamFixture(db, ids, {
      name: "Real Estate Crew",
      memberIds: [ids.users.editor1, ids.users.photographer1],
      leadUserId: ids.users.photographer1,
    });
    await addTeamFixture(db, ids, { name: "Old", memberIds: [], archived: true });
    const asMember = await contextFor(db, ids.users.photographer2);
    expect((await listTeams(db, asMember, { includeArchived: "1" })).map((t) => t.name)).toEqual(["Real Estate Crew"]);
    expect(await listTeams(db, await contextFor(db, ids.users.owner), { includeArchived: "1" })).toHaveLength(2);
    expect(await getTeamDetail(db, asMember, teamId)).toMatchObject({ memberCount: 2, memberships: [] });
    expect((await getTeamDetail(db, await contextFor(db, ids.users.coAdmin), teamId)).memberships).toHaveLength(2);
    // editors and clients: team.view_members is admins + members only (§3.3)
    await expect(listTeams(db, await contextFor(db, ids.users.editor1))).rejects.toThrow(ForbiddenError);
    await expect(getTeamDetail(db, await contextFor(db, ids.users.client), teamId)).rejects.toThrow(ForbiddenError);
  });
});

describe("settings / workflows / automations / views", () => {
  it("settings and the roles matrix are admin only; prefs default to enabled and follow the persona", async () => {
    expect(await getSettingsView(db, await contextFor(db, ids.users.owner))).toMatchObject({ canManage: true, organisation: { slug: "studio" } });
    expect((await getSettingsView(db, await contextFor(db, ids.users.coAdmin))).canManage).toBe(true);
    await expect(getSettingsView(db, await contextFor(db, ids.users.lead))).rejects.toThrow(ForbiddenError);
    await expect(getSettingsView(db, await contextFor(db, ids.users.editor1))).rejects.toThrow(ForbiddenError);
    await expect(getSettingsView(db, await contextFor(db, ids.users.client))).rejects.toThrow(ForbiddenError);
    expect(getPermissionMatrix(await contextFor(db, ids.users.coAdmin)).length).toBeGreaterThan(50);
    const prefs = await getNotificationPrefs(db, await contextFor(db, ids.users.editor1));
    expect(prefs.every((p) => p.enabled)).toBe(true);
    expect(prefs.some((p) => p.type === "client_work_shared")).toBe(false);
    const clientPrefs = await getNotificationPrefs(db, await contextFor(db, ids.users.client));
    expect(clientPrefs.map((p) => p.type).sort()).toEqual(["client_feedback_reply", "client_work_delivered", "client_work_shared"]);
  });

  it("workflow graph lists statuses with job counts and validates clean", async () => {
    const ctx = await contextFor(db, ids.users.coAdmin);
    expect((await listWorkflows(db, ctx))[0]).toMatchObject({ isDefault: true, statusCount: 13, openJobCount: 1 });
    const g = await getWorkflowGraph(db, ctx, ids.workflowId);
    expect(g.statuses).toHaveLength(13);
    expect(g.statuses.find((s) => s.key === "in_progress")?.jobCount).toBe(1);
    expect(g.transitions.some((t) => t.generated)).toBe(false); // seeded cancel edges exist
    expect(g.validation).toEqual([]);
    await expect(getWorkflowGraph(db, await contextFor(db, ids.users.photographer1), ids.workflowId)).rejects.toThrow(ForbiddenError);
    expect((await listJobTypes(db, await contextFor(db, ids.users.photographer1))).length).toBe(10);
    await expect(listJobTypes(db, await contextFor(db, ids.users.client))).rejects.toThrow(ForbiddenError);
    await expect(listWorkflows(db, await contextFor(db, ids.users.lead))).rejects.toThrow(ForbiddenError);
  });

  it("automations and runs are admin-only; empty org lists cleanly", async () => {
    expect(await listAutomations(db, await contextFor(db, ids.users.coAdmin))).toEqual([]);
    expect(await listAutomationRuns(db, await contextFor(db, ids.users.owner))).toEqual({ items: [], nextCursor: null });
    await expect(listAutomations(db, await contextFor(db, ids.users.editor1))).rejects.toThrow(ForbiddenError);
    await expect(listAutomations(db, await contextFor(db, ids.users.lead))).rejects.toThrow(ForbiddenError);
    await expect(listAutomationRuns(db, await contextFor(db, ids.users.client))).rejects.toThrow(ForbiddenError);
    await expect(getAutomationDetail(db, await contextFor(db, ids.users.coAdmin), "nope")).rejects.toThrow(NotFoundError);
  });

  it("saved views: own + shared; someone else's private view is 404", async () => {
    const config = { filters: { quick: "overdue" }, sort: [], columns: ["job" as const] };
    await db.insert(savedViews).values([
      { id: "v1", organisationId: ids.organisationId, ownerUserId: ids.users.editor1, name: "Mine", scope: "all_work", config },
      { id: "v2", organisationId: ids.organisationId, ownerUserId: ids.users.coAdmin, name: "Overdue", scope: "all_work", config, isShared: true },
      { id: "v3", organisationId: ids.organisationId, ownerUserId: ids.users.coAdmin, name: "Private", scope: "all_work", config },
    ]);
    const ctx = await contextFor(db, ids.users.editor1);
    expect((await listSavedViews(db, ctx, { scope: "all_work" })).map((v) => [v.id, v.isMine])).toEqual([
      ["v1", true],
      ["v2", false],
    ]);
    expect((await getSavedView(db, ctx, "v2")).config.filters.quick).toBe("overdue");
    await expect(getSavedView(db, ctx, "v3")).rejects.toThrow(NotFoundError);
    // clients have no saved views (403), not even shared ones
    await expect(listSavedViews(db, await contextFor(db, ids.users.client))).rejects.toThrow(ForbiddenError);
    await expect(getSavedView(db, await contextFor(db, ids.users.client), "v2")).rejects.toThrow(ForbiddenError);
  });
});

describe("editor directory stats = workload rows", () => {
  it("active / dueToday / overdue match computeWorkloads even when the editor holds approved or delivered jobs", async () => {
    const e1 = ids.users.editor1;
    await insertJobFixture(db, ids, { statusKey: "submitted", editorId: e1 });
    await insertJobFixture(db, ids, { statusKey: "approved", editorId: e1 });
    await insertJobFixture(db, ids, { statusKey: "delivered", editorId: e1 });
    await insertJobFixture(db, ids, { statusKey: "accepted", editorId: ids.users.editor2, dueDate: "2026-10-08T12:59:59.999Z" });
    const ctx = await contextFor(db, ids.users.coAdmin);
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
