import type { Page } from "@playwright/test";
import { ROLE_EMAILS, civilDate, eventually, loginApi, uniq, type Api } from "./api";
import { FORBIDDEN_TEXT, UI_TEST_TIMEOUT, expect, gotoReady, retrying, test } from "./fixtures";

/**
 * Owner / Photographer (docs/ROLES.md §0, §2–§4, §6, §8, §10–§11).
 *
 * The person who runs the business is a photographer with admin (and the
 * primary owner). They see and change everything without switching accounts or
 * roles; their own shoots are ordinary jobs; the topbar switch flips between a
 * personal "My shoots" view and the "Whole business" view.
 *
 * The scope cookie (`pwm_scope`) lives in a cookie jar: tests set it only on
 * disposable sessions (`apiAs`, the test's own browser context), never on the
 * worker-scoped `api`, so no other spec ever runs scoped.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

/** The topbar segmented control (§8): "My shoots | Whole business". */
function scopeOption(page: Page, label: "My shoots" | "Whole business") {
  const banner = page.getByRole("banner");
  return banner
    .getByRole("radio", { name: label })
    .or(banner.getByRole("tab", { name: label }))
    .or(banner.getByRole("button", { name: label }))
    .first();
}

async function twoShoots(api: Api, label: string) {
  const owner = await api.me();
  const p02 = await api.userByEmail(ROLE_EMAILS["photographer-noflags"]);
  const term = uniq(`Scope ${label}`);
  const { projectId } = await api.createClientAndProject(`Scope ${label}`);
  // No photographerId: an admin's own job defaults to themselves (§3.3 job.create).
  const mine = await api.createJob({ name: `${term} mine`, projectId });
  // Created BY the owner FOR photographer02: managed by the owner, but not one of "my shoots" (§8).
  const theirs = await api.createJob({ name: `${term} theirs`, projectId, photographerId: p02.id });
  return { owner, p02, term, mine, theirs };
}

test("the owner is an Owner / Photographer admin with every switch, and opens every area", async ({ page, api }) => {
  const me = await api.me();
  expect(me.user.role).toBe("photographer");
  expect(me.user.persona).toBe("admin");
  expect(me.user.personaLabel).toBe("Owner / Photographer");
  expect(me.user.isAdmin).toBe(true);
  expect(me.user.isPrimaryOwner).toBe(true);
  for (const flag of ["canCreateJobs", "canViewAllJobs", "canAssignEditors", "canReviewSubmissions", "canViewTeamWorkloads", "canViewAnalytics"] as const) {
    expect(me.user[flag], flag).toBe(true);
  }

  for (const path of [
    "/workspace/team",
    "/team/photographers",
    "/team/editors",
    "/team/workloads",
    "/team/performance",
    "/insights/analytics",
    "/insights/bottlenecks",
    "/insights/reports",
    "/settings/organisation",
    "/settings/users",
    "/settings/roles",
    "/settings/teams",
    "/settings/workflows",
    "/settings/job-types",
    "/settings/automations",
  ]) {
    const res = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(res?.status(), path).toBe(200);
    await expect(page.getByText(FORBIDDEN_TEXT), path).toHaveCount(0);
  }

  // Unrestricted analytics, workloads and the integrity check.
  for (const url of ["/api/workloads", "/api/analytics/overview", "/api/bottlenecks", "/api/system/integrity", "/api/settings"]) {
    expect((await api.raw("GET", url)).status, url).toBe(200);
  }

  // The sidebar offers every section, settings included.
  await gotoReady(page, "/dashboard", page.getByRole("navigation", { name: "Main" }));
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const href of ["/workspace/team", "/team/workloads", "/insights/analytics", "/settings/organisation", "/settings/users", "/settings/roles"]) {
    await expect(nav.locator(`a[href="${href}"]`), href).toHaveCount(1);
  }
});

test("the Roles page explains the three roles and the account menu shows the persona", async ({ page }) => {
  await gotoReady(page, "/settings/roles", page.getByRole("main"));
  await expect(page.getByRole("main")).toContainText("Three roles: Photographer, Editor and Client.");
  await expect(page.getByRole("main")).toContainText("Owner / Photographer");
  await expect(page.getByRole("main")).toContainText("Photographer (team member)");

  const menuButton = page.getByRole("banner").getByRole("button", { name: /^Account menu for / });
  await retrying(async () => {
    if (!(await page.getByRole("menu", { name: "Account" }).isVisible())) await menuButton.click({ timeout: 5_000 });
    await expect(page.getByRole("menu", { name: "Account" })).toBeVisible({ timeout: 3_000 });
  });
  await expect(page.getByRole("menu", { name: "Account" })).toContainText("Owner / Photographer");
});

test("scope switch: My shoots shows only jobs I photograph; Whole business shows everything (API)", async ({ api, apiAs }) => {
  const { owner, p02, term, mine, theirs } = await twoShoots(api, "api");
  expect(mine.photographer?.id).toBe(owner.user.id);
  expect(theirs.photographer?.id).toBe(p02.id);

  // A disposable owner session: the cookie set here never reaches other specs.
  const session = await apiAs("owner");
  const ids = async (scope?: "mine" | "business") => (await session.jobsMatching(term, scope)).map((r) => r.id).sort();

  // Default (no param, no cookie) = Whole business.
  expect(await ids()).toEqual([mine.id, theirs.id].sort());
  // ?scope= wins and filters "My shoots" by photographer only (not by creator).
  expect(await ids("mine")).toEqual([mine.id]);
  expect(await ids("business")).toEqual([mine.id, theirs.id].sort());

  // The cookie (POST /api/me/scope) applies when no param is given; the param still wins.
  await session.setScope("mine");
  expect(await ids()).toEqual([mine.id]);
  expect(await ids("business")).toEqual([mine.id, theirs.id].sort());

  // Kanban and the dashboard honour the same scope.
  const kanbanMine = JSON.stringify(await session.get<unknown>(`/api/kanban?q=${encodeURIComponent(term)}&scope=mine`));
  expect(kanbanMine).toContain(mine.id);
  expect(kanbanMine).not.toContain(theirs.id);
  const kanbanAll = JSON.stringify(await session.get<unknown>(`/api/kanban?q=${encodeURIComponent(term)}&scope=business`));
  expect(kanbanAll).toContain(theirs.id);

  const activeOf = async (scope: "mine" | "business") => (await session.get<{ kpis: { active: number } }>(`/api/dashboard?scope=${scope}`)).kpis.active;
  // "theirs" is active and not mine, so the business count is strictly larger.
  expect(await activeOf("business")).toBeGreaterThan(await activeOf("mine"));

  await session.setScope("business");
  expect(await ids()).toEqual([mine.id, theirs.id].sort());
  // Invalid scope values are a 400, not a silent widening or narrowing.
  expect((await session.raw("POST", "/api/me/scope", { scope: "everyone" })).status).toBe(400);
});

test("scope switch in the topbar changes All Work and persists across a reload", async ({ page, api }) => {
  const { term, mine, theirs } = await twoShoots(api, "ui");
  const main = page.getByRole("main");
  // All Work renders each job as a table row link and again in a CSS-hidden card list; match the
  // accessible row link so hidden duplicates never trip strict mode.
  const row = (name: string) => main.getByRole("link", { name });
  const url = `/workspace/all?q=${encodeURIComponent(term)}`;

  await gotoReady(page, url, row(mine.name));
  await expect(row(theirs.name)).toBeVisible();

  await retrying(async () => {
    await scopeOption(page, "My shoots").click({ timeout: 5_000 });
    await expect(row(theirs.name)).toHaveCount(0, { timeout: 10_000 });
  });
  await expect(row(mine.name)).toBeVisible();

  // The choice is a cookie: it survives a reload.
  await page.reload();
  await expect(row(mine.name)).toBeVisible();
  await expect(row(theirs.name)).toHaveCount(0);
  expect((await page.context().cookies()).find((c) => c.name === "pwm_scope")?.value).toBe("mine");

  await retrying(async () => {
    await scopeOption(page, "Whole business").click({ timeout: 5_000 });
    await expect(row(theirs.name)).toBeVisible({ timeout: 10_000 });
  });
  await expect(row(mine.name)).toBeVisible();
});

test("the owner runs another photographer's job end to end: assign, re-date, review, deliver, complete, reopen", async ({ api }) => {
  const p02 = await api.userByEmail(ROLE_EMAILS["photographer-noflags"]);
  const editorA = await api.inviteUser("editor", "Owner A");
  const editorB = await api.inviteUser("editor", "Owner B");
  const job = await api.createJob({ name: uniq("Owner runs"), photographerId: p02.id, dueDate: civilDate(5) });
  expect(job.photographer?.id).toBe(p02.id);

  // Assign, then reassign before work starts.
  await api.assignEditor(job.id, editorA.user.id);
  await api.assignEditor(job.id, editorB.user.id, "E2E: rebalance");
  expect((await api.job(job.id)).job.editor?.id).toBe(editorB.user.id);

  // Deadlines, priority and links on someone else's job.
  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), dueDate: civilDate(3), priority: "high" });
  await api.addLink(job.id, "raw_files", `https://example.com/raw/${Date.now()}`, "Raw files");
  await api.addLink(job.id, "reference", `https://example.com/ref/${Date.now()}`, "Brief");

  const ed = await loginApi(editorB.email, editorB.tempPassword);
  await ed.driveToSubmitted(job.id);
  await ed.dispose();

  // Review: request a revision, then approve the resubmission.
  await api.requestRevision(job.id, "Sky too blue", "Tone down the sky in images 3 and 5.");
  const ed2 = await loginApi(editorB.email, editorB.tempPassword);
  await ed2.resolveRevision(job.id, "Fixed");
  await ed2.dispose();
  for (const verb of ["approve", "deliver", "complete"] as const) await api.action(job.id, verb);
  expect((await api.job(job.id)).job.statusCategory).toBe("completed");

  await api.reopen(job.id, "E2E: client asked for one more crop", "in_progress");
  const reopened = await api.waitForCategory(job.id, "in_progress");
  expect(reopened.job.reopenedCount).toBe(1);
});

test("team management: a team member becomes a co-admin and back; nobody else can touch the primary owner", async ({ api }) => {
  const ownerId = (await api.me()).user.id;
  const member = await api.inviteUser("photographer", "CoAdmin");

  // Invite defaults (§2.2): create ✓, assign ✓, review ✗, the rest ✗.
  let session = await loginApi(member.email, member.tempPassword);
  let me = await session.me();
  expect(me.user.persona).toBe("member");
  expect(me.user.personaLabel).toBe("Photographer (team member)");
  expect(me.user.isAdmin).toBe(false);
  expect(me.user.canCreateJobs).toBe(true);
  expect(me.user.canAssignEditors).toBe(true);
  expect(me.user.canReviewSubmissions).toBe(false);
  expect(me.user.canViewAllJobs).toBe(false);
  expect(me.user.canViewTeamWorkloads).toBe(false);
  expect(me.user.canViewAnalytics).toBe(false);
  // A team member cannot grant themselves admin.
  expect((await session.raw("POST", `/api/users/${member.user.id}/admin`, { isAdmin: true, expectedVersion: member.user.version })).status).toBe(403);
  await session.dispose();

  // Grant admin: the change applies on the next request (contexts re-read the user).
  await api.setAdmin(member.user.id, true);
  session = await loginApi(member.email, member.tempPassword);
  me = await session.me();
  expect(me.user.persona).toBe("admin");
  expect(me.user.isPrimaryOwner).toBe(false);
  expect(me.user.canViewAnalytics).toBe(true);
  expect((await session.raw("GET", "/api/settings")).status).toBe(200);

  // Admins have every permission: switches cannot be set on an admin.
  expect((await api.raw("POST", `/api/users/${member.user.id}/permissions`, { canViewAnalytics: false, expectedVersion: await api.userVersion(member.user.id) })).status).toBe(422);

  // Primary-owner protection (§3.4): the co-admin cannot demote, deactivate, re-email or reset the owner.
  const ownerVersion = await api.userVersion(ownerId);
  for (const [url, body] of [
    [`/api/users/${ownerId}/admin`, { isAdmin: false, expectedVersion: ownerVersion }],
    [`/api/users/${ownerId}/deactivate`, { expectedVersion: ownerVersion, reason: "E2E takeover" }],
    [`/api/users/${ownerId}/reset-password`, { expectedVersion: ownerVersion }],
    [`/api/users/${ownerId}/role`, { role: "editor", expectedVersion: ownerVersion }],
  ] as const) {
    const res = await session.raw("POST", url, body);
    expect([403, 422], url).toContain(res.status);
  }
  const ownerAfter = await api.me();
  expect(ownerAfter.user.isAdmin).toBe(true);
  expect(ownerAfter.user.isPrimaryOwner).toBe(true);
  await session.dispose();

  // The owner can neither revoke their own admin nor deactivate themselves.
  expect([403, 422]).toContain((await api.raw("POST", `/api/users/${ownerId}/admin`, { isAdmin: false, expectedVersion: await api.userVersion(ownerId) })).status);
  expect([403, 422]).toContain((await api.raw("POST", `/api/users/${ownerId}/deactivate`, { expectedVersion: await api.userVersion(ownerId), reason: "E2E self" })).status);

  // Revoke: back to a team member with their stored switches.
  await api.setAdmin(member.user.id, false);
  session = await loginApi(member.email, member.tempPassword);
  me = await session.me();
  expect(me.user.persona).toBe("member");
  expect(me.user.canReviewSubmissions).toBe(false);
  expect((await session.raw("GET", "/api/settings")).status).toBe(403);
  await session.dispose();

  // The audit trail records both admin changes.
  const events = await eventually(async () => {
    const list = await api.get<{ items: { eventType: string; entityId?: string; metadata: Record<string, unknown> }[] }>("/api/activity?limit=200");
    const hits = list.items.filter((e) => e.eventType === "user.admin_changed" && JSON.stringify(e).includes(member.user.id));
    return hits.length >= 2 ? hits : null;
  });
  expect(events.length).toBeGreaterThanOrEqual(2);

  await api.deactivateUser(member.user.id, "E2E co-admin test done");
});

test("inviting: the dialog offers the three roles, and a client user needs a client with the portal on", async ({ page, api }) => {
  await gotoReady(page, "/settings/users?invite=1", page.getByRole("dialog"));
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Shoots and works on their own jobs. You choose what else they can do.");
  await expect(dialog).toContainText("Edits the jobs assigned to them and can create jobs for a photographer.");
  await expect(dialog).toContainText("Sees only the work you share with them, in a simple portal.");

  // Client users: portal off → 422; portal on → created, and they sign in to the portal.
  const { clientId } = await api.createClientAndProject("Invite portal");
  const stamp = Date.now().toString(36);
  const off = await api.raw("POST", "/api/users", { email: `e2e-client-off-${stamp}@studio.test`, name: "E2E Portal Off", role: "client", clientId });
  expect(off.status).toBe(422);
  await api.setClientPortal(clientId, { portalEnabled: true });
  const client = await api.inviteUser("client", { label: "Invite", clientId });
  const login = await loginApi(client.email, client.tempPassword);
  const me = await login.clientMe();
  expect(me.kind).toBe("client");
  await login.dispose();

  // Never a client without a client, never staff flags on a client.
  expect((await api.raw("POST", "/api/users", { email: `e2e-client-none-${stamp}@studio.test`, name: "E2E No Client", role: "client" })).status).toBe(400);
  expect(
    (await api.raw("POST", "/api/users", { email: `e2e-client-admin-${stamp}@studio.test`, name: "E2E Client Admin", role: "client", clientId, isAdmin: true })).status,
  ).toBe(400);
});
