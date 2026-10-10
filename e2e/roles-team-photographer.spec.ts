import type { Page } from "@playwright/test";
import { ROLE_EMAILS, loginApi, uniq, type Api, type InvitedUser } from "./api";
import { FORBIDDEN_TEXT, JOB_NOT_FOUND_TEXT, UI_TEST_TIMEOUT, expect, gotoReady, jobHeading, storageFor, test } from "./fixtures";

/**
 * Additional photographers are team members, not a fourth role (docs/ROLES.md
 * §0, §2.2, §3.3, §10, §12.2 roles-member). The owner invites them and decides,
 * switch by switch, what else they can do; none of them is ever an admin by
 * default.
 *
 * - A freshly invited member has the invite defaults: create ✓, assign ✓,
 *   review ✗, See all jobs ✗, workloads ✗, analytics ✗.
 * - photographer01 ("photographer") has every switch.
 * - photographer12 ("photographer-restricted") may create jobs only.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const ADMIN_ONLY_PAGES = ["/settings/organisation", "/settings/users", "/settings/roles", "/settings/workflows", "/settings/automations"];
const ANALYTICS_PAGES = ["/insights/analytics", "/insights/bottlenecks", "/insights/reports", "/team/performance"];

async function expectStatus(page: Page, path: string, status: number): Promise<void> {
  const res = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(res?.status(), path).toBe(status);
  if (status === 403) await expect(page.getByText(FORBIDDEN_TEXT), path).toBeVisible();
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Main" });

async function newMember(api: Api, label: string): Promise<{ member: InvitedUser; session: Api }> {
  const member = await api.inviteUser("photographer", label);
  return { member, session: await loginApi(member.email, member.tempPassword) };
}

test("a newly invited team member has the invite defaults and creates jobs as their own photographer", async ({ api }) => {
  const { member, session } = await newMember(api, "Defaults");
  const me = await session.me();
  expect(me.user).toMatchObject({
    role: "photographer",
    persona: "member",
    personaLabel: "Photographer (team member)",
    isAdmin: false,
    isPrimaryOwner: false,
    canCreateJobs: true,
    canAssignEditors: true,
    canReviewSubmissions: false,
    canViewAllJobs: false,
    canViewTeamWorkloads: false,
    canViewAnalytics: false,
    canViewTeamJobs: false,
  });

  // "Create jobs" also covers clients and projects (§2.2).
  const { projectId } = await session.createClientAndProject("Member");
  const own = await session.createJob({ name: uniq("Member own"), projectId });
  expect(own.photographer?.id).toBe(member.user.id);
  expect(own.detail.job.createdBy.id).toBe(member.user.id);

  // The photographer is forced to self: naming someone else is job.assign_photographer (admins only).
  const ownerId = (await api.me()).user.id;
  const jobTypeId = await session.jobTypeId();
  const forOwner = await session.raw("POST", "/api/jobs", { name: uniq("Member for owner"), projectId, jobTypeId, photographerId: ownerId });
  expect(forOwner.status).toBe(403);

  // Assign editors ✓ (invite default): they may pick the editor on their own job.
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const withEditor = await session.createJob({ name: uniq("Member with editor"), projectId, editorId: editor.id });
  expect(withEditor.editor?.id).toBe(editor.id);
  expect(withEditor.statusCategory).toBe("assigned");

  await session.dispose();
});

test("a default team member sees only the jobs they manage; ?scope= is ignored for them", async ({ api }) => {
  const { member, session } = await newMember(api, "Visibility");
  const p02 = await api.userByEmail(ROLE_EMAILS["photographer-noflags"]);
  const term = uniq("Member visibility");
  const { projectId } = await api.createClientAndProject("Member visibility");
  // Assigned to them by the owner (they are its photographer) → managed.
  const assigned = await api.createJob({ name: `${term} assigned`, projectId, photographerId: member.user.id });
  // Someone else's shoot → invisible.
  const foreign = await api.createJob({ name: `${term} foreign`, projectId, photographerId: p02.id });

  expect((await session.raw("GET", `/api/jobs/${assigned.id}`)).status).toBe(200);
  expect((await session.raw("GET", `/api/jobs/${foreign.id}`)).status).toBe(404);
  expect((await session.raw("GET", `/api/jobs/${foreign.id}/history`)).status).toBe(404);
  const ids = async (scope?: "mine" | "business") => (await session.jobsMatching(term, scope)).map((r) => r.id).sort();
  expect(await ids()).toEqual([assigned.id]);
  // Without See all jobs the switch is not theirs: the param is ignored, never an error or a widening.
  expect(await ids("business")).toEqual([assigned.id]);
  expect(await ids("mine")).toEqual([assigned.id]);
  const search = await session.get<{ jobs: { id: string }[] }>(`/api/search?q=${encodeURIComponent(term)}`);
  expect(search.jobs.map((j) => j.id)).not.toContain(foreign.id);

  // They edit their own job's fields; they cannot cancel or re-date a job the owner created
  // for them without Review submissions (the "controls" scope, §3.2).
  await session.patch(`/api/jobs/${assigned.id}`, { expectedVersion: await session.version(assigned.id), name: `${term} assigned renamed` });
  expect((await session.raw("PATCH", `/api/jobs/${assigned.id}`, { expectedVersion: await session.version(assigned.id), priority: "urgent" })).status).toBe(403);
  expect((await session.raw("POST", `/api/jobs/${assigned.id}/cancel`, { expectedVersion: await session.version(assigned.id), reason: "E2E" })).status).toBe(403);

  await session.dispose();
});

test("reviews of a default team member's jobs come to the owner", async ({ api }) => {
  const { member, session } = await newMember(api, "Review");
  const editor = await api.inviteUser("editor", "Member review");
  const { projectId } = await session.createClientAndProject("Member review");
  const job = await session.createJob({ name: uniq("Member review"), projectId, editorId: editor.user.id });

  const ed = await loginApi(editor.email, editor.tempPassword);
  await ed.driveToSubmitted(job.id);
  await ed.dispose();

  // No Review submissions: approve / request revision are refused and not offered.
  const detail = await session.job(job.id);
  expect(detail.actions.transitions.map((t) => t.toStatus.category)).not.toContain("approved");
  expect((await session.raw("POST", `/api/jobs/${job.id}/approve`, { expectedVersion: detail.job.version })).status).toBe(403);
  expect((await session.raw("POST", `/api/jobs/${job.id}/revisions`, { expectedVersion: detail.job.version, reason: "x", description: "y" })).status).toBe(403);

  // The owner reviews it.
  await api.action(job.id, "approve");
  expect((await api.job(job.id)).job.statusCategory).toBe("approved");
  // Delivering is a review action too.
  expect((await session.raw("POST", `/api/jobs/${job.id}/deliver`, { expectedVersion: await session.version(job.id) })).status).toBe(403);

  // With Review submissions switched on they review their own jobs.
  await api.setPermissions(member.user.id, { canReviewSubmissions: true });
  await session.action(job.id, "deliver");
  expect((await api.job(job.id)).job.statusCategory).toBe("delivered");
  await session.dispose();
});

test("a default team member cannot open settings, analytics, workloads or Team Work", async ({ api, pageWithState }) => {
  const member = await api.inviteUser("photographer", "Pages");
  const page = await pageWithState(await storageFor(member.email, member.tempPassword));

  for (const path of [...ADMIN_ONLY_PAGES, ...ANALYTICS_PAGES, "/team/workloads", "/workspace/team"]) await expectStatus(page, path, 403);
  // Directories are open to every team member (team.view_members).
  for (const path of ["/team/photographers", "/team/editors", "/workspace/all", "/jobs/new"]) await expectStatus(page, path, 200);

  const session = await loginApi(member.email, member.tempPassword);
  for (const url of ["/api/settings", "/api/analytics/overview", "/api/bottlenecks", "/api/performance", "/api/system/integrity"]) {
    expect((await session.raw("GET", url)).status, url).toBe(403);
  }
  // Workloads without the switch: at most their own row, never an editor's.
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const workloads = await session.get<unknown[]>("/api/workloads");
  expect(workloads.length).toBeLessThanOrEqual(1);
  expect(JSON.stringify(workloads)).not.toContain(editor.id);
  await session.dispose();

  // The navigation agrees (§10 "M default" column), and there is no scope switch.
  await gotoReady(page, "/dashboard", sidebar(page));
  const nav = sidebar(page);
  for (const href of ["/workspace/team", "/team/workloads", "/team/performance", "/insights/analytics", "/settings/organisation", "/settings/users"]) {
    await expect(nav.locator(`a[href="${href}"]`), href).toHaveCount(0);
  }
  for (const href of ["/workspace/all", "/workspace/my", "/team/photographers", "/team/editors", "/activity"]) {
    await expect(nav.locator(`a[href="${href}"]`), href).toHaveCount(1);
  }
  await expect(page.getByRole("banner").getByText("Whole business")).toHaveCount(0);
});

test("the owner configures switches: workloads, analytics and See all jobs apply at once; create can be switched off", async ({ api, pageWithState }) => {
  const { member, session } = await newMember(api, "Switches");
  const page = await pageWithState(await storageFor(member.email, member.tempPassword));

  await api.setPermissions(member.user.id, { canViewTeamWorkloads: true, canViewAnalytics: true });
  expect(await session.me()).toMatchObject({ user: { canViewTeamWorkloads: true, canViewAnalytics: true, isAdmin: false } });
  await expectStatus(page, "/team/workloads", 200);
  for (const path of ANALYTICS_PAGES) await expectStatus(page, path, 200);
  // Never admin: settings stay closed.
  for (const path of ADMIN_ONLY_PAGES) await expectStatus(page, path, 403);
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  expect(JSON.stringify(await session.get<unknown[]>("/api/workloads"))).toContain(editor.id);
  expect((await session.raw("GET", "/api/analytics/overview")).status).toBe(200);

  // See all jobs: read every job (and comment), change only their own; the scope switch appears.
  const p02 = await api.userByEmail(ROLE_EMAILS["photographer-noflags"]);
  const others = await api.createJob({ name: uniq("Switches others"), photographerId: p02.id });
  expect((await session.raw("GET", `/api/jobs/${others.id}`)).status).toBe(404);
  await api.setPermissions(member.user.id, { canViewAllJobs: true });
  expect((await session.raw("GET", `/api/jobs/${others.id}`)).status).toBe(200);
  expect((await session.raw("PATCH", `/api/jobs/${others.id}`, { expectedVersion: await session.version(others.id), name: "E2E not mine" })).status).toBe(403);
  await session.addComment(others.id, "E2E: comments are collaboration, not control");
  expect((await session.jobsMatching(others.name, "mine")).map((r) => r.id)).toEqual([]);
  expect((await session.jobsMatching(others.name, "business")).map((r) => r.id)).toEqual([others.id]);
  await gotoReady(page, "/dashboard", page.getByRole("banner"));
  await expect(page.getByRole("banner").getByText("Whole business").first()).toBeVisible();

  // Editor-only switch on a photographer → 422.
  expect((await api.raw("POST", `/api/users/${member.user.id}/permissions`, { canViewTeamJobs: true, expectedVersion: await api.userVersion(member.user.id) })).status).toBe(422);

  // Create jobs off: no New job, and the API refuses.
  await api.setPermissions(member.user.id, { canCreateJobs: false });
  const { projectId } = await api.createClientAndProject("Switches off");
  const jobTypeId = await session.jobTypeId();
  expect((await session.raw("POST", "/api/jobs", { name: uniq("Switches off"), projectId, jobTypeId })).status).toBe(403);
  expect((await session.raw("POST", "/api/clients", { name: uniq("Switches off client") })).status).toBe(403);
  await expectStatus(page, "/jobs/new", 403);
  await session.dispose();
});

test.describe("photographer01 (every switch)", () => {
  test.use({ role: "photographer" });

  test("sees all jobs read-only, workloads and analytics, and never settings", async ({ page, api, apiAs }) => {
    const p01 = await apiAs("photographer");
    expect((await p01.me()).user).toMatchObject({ persona: "member", isAdmin: false, canViewAllJobs: true, canViewAnalytics: true, canViewTeamWorkloads: true });

    for (const path of ["/team/workloads", "/workspace/team", ...ANALYTICS_PAGES]) await expectStatus(page, path, 200);
    for (const path of ADMIN_ONLY_PAGES) await expectStatus(page, path, 403);

    // The owner's own shoot: visible, not changeable.
    const ownerShoot = await api.createJob({ name: uniq("P01 owner shoot") });
    await page.goto(`/jobs/${ownerShoot.id}`);
    await expect(jobHeading(page)).toContainText(ownerShoot.name);
    // Exactly "Edit" (the job header button); the sidebar's "Editors" directory link must not match.
    await expect(page.getByRole("link", { name: /^Edit$/ })).toHaveCount(0);
    expect((await p01.raw("PATCH", `/api/jobs/${ownerShoot.id}`, { expectedVersion: ownerShoot.version, name: "E2E nope" })).status).toBe(403);
    expect((await p01.raw("POST", `/api/jobs/${ownerShoot.id}/cancel`, { expectedVersion: ownerShoot.version, reason: "E2E nope" })).status).toBe(403);
    const editor = await api.userByEmail(ROLE_EMAILS.editor);
    expect((await p01.raw("POST", `/api/jobs/${ownerShoot.id}/assign`, { role: "editor", userId: editor.id, expectedVersion: ownerShoot.version })).status).toBe(403);
  });
});

test.describe("photographer12 (create only: no assigning, no reviewing)", () => {
  test.use({ role: "photographer-restricted" });

  test("cannot assign or unassign editors (directly, by a move, a kanban drop or in bulk) and cannot approve", async ({ page, api, apiAs }) => {
    const p12 = await apiAs("photographer-restricted");
    const p12Id = (await p12.me()).user.id;
    expect((await p12.me()).user).toMatchObject({ canCreateJobs: true, canAssignEditors: false, canReviewSubmissions: false });

    const editor = await api.inviteUser("editor", "P12");
    const other = await api.inviteUser("editor", "P12 other");
    const job = await api.createJob({ name: uniq("P12 job"), photographerId: p12Id, editorId: editor.user.id });
    const v = await p12.version(job.id);

    expect((await p12.raw("POST", `/api/jobs/${job.id}/assign`, { role: "editor", userId: other.user.id, expectedVersion: v })).status).toBe(403);
    expect((await p12.raw("POST", `/api/jobs/${job.id}/assign`, { role: "editor", userId: null, expectedVersion: v })).status).toBe(403);
    // Moving back to Ready would drop the editor: that is job.assign_editor (§5.2).
    expect((await p12.rawTransition(job.id, "ready", v)).status).toBe(403);
    expect((await p12.raw("POST", "/api/kanban/drop", { jobId: job.id, column: "new", expectedVersion: v })).status).toBeGreaterThanOrEqual(400);
    const bulk = await p12.raw<{ ok: string[]; failed: { id: string }[] }>("POST", "/api/jobs/bulk/transition", { jobIds: [job.id], toCategory: "ready" });
    if (bulk.ok) expect(bulk.data.ok).not.toContain(job.id);
    const after = await api.job(job.id);
    expect(after.job.editor?.id).toBe(editor.user.id);
    expect(after.job.statusCategory).toBe("assigned");

    // A job they create has no editor picker for them.
    await gotoReady(page, "/jobs/new", page.getByRole("form", { name: "Create job" }));
    await expect(page.getByRole("form", { name: "Create job" }).getByRole("button", { name: "Editor", exact: true })).toHaveCount(0);

    // Review: refused, button absent, the owner's hint shown.
    const ed = await loginApi(editor.email, editor.tempPassword);
    await ed.driveToSubmitted(job.id);
    await ed.dispose();
    expect((await p12.raw("POST", `/api/jobs/${job.id}/approve`, { expectedVersion: await p12.version(job.id) })).status).toBe(403);
    await page.goto(`/jobs/${job.id}`);
    await expect(jobHeading(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await expect(page.getByText("Your studio owner reviews this job")).toBeVisible();
  });

  test("another photographer's job is a 404 page", async ({ page, api }) => {
    const p02 = await api.userByEmail(ROLE_EMAILS["photographer-noflags"]);
    const job = await api.createJob({ name: uniq("P12 foreign"), photographerId: p02.id });
    const res = await page.goto(`/jobs/${job.id}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByText(JOB_NOT_FOUND_TEXT)).toBeVisible();
  });
});
