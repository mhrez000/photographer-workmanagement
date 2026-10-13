import { ROLE_EMAILS, eventually, loginApi, uniq, type JobRow } from "./api";
import { FORBIDDEN_TEXT, JOB_NOT_FOUND_TEXT, UI_TEST_TIMEOUT, expect, jobHeading, storageFor, test } from "./fixtures";

/**
 * Permissions (docs/ROLES.md §2–§3; docs/SIMPLIFICATION-PLAN.md §2, §9 "Permissions"). Every action is
 * still checked on the server: pages a persona may not open are a real 403 (or a 404 for hidden
 * pages), records outside the viewer's org or visibility are a 404 (no existence leak). The three
 * role presets just pre-fill the existing switches.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

async function listByName(api: { get: <T>(u: string) => Promise<T> }, name: string): Promise<JobRow[]> {
  const res = await api.get<{ rows: JobRow[] }>(`/api/jobs?q=${encodeURIComponent(name)}&limit=50`);
  return res.rows;
}

test.describe("editor role", () => {
  test.use({ role: "editor" });

  // Owner pages are refused (403 / 404); the staff pages an editor simply doesn't have (Home, Clients) send them to My jobs.
  for (const path of ["/settings/studio", "/settings/people", "/settings/history", "/editors", "/clients", "/home"]) {
    test(`is blocked from ${path}`, async ({ page, apiAs }) => {
      const { status, location } = await (await apiAs("editor")).pageStatus(path);
      if (status === 307) {
        expect(location, path).toMatch(/\/my-jobs$/);
        expect(["/clients", "/home"], `${path} may only redirect, never an owner page`).toContain(path);
        return;
      }
      expect([403, 404], path).toContain(status);
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(status);
      if (status === 403) await expect(page.getByText(FORBIDDEN_TEXT)).toBeVisible();
    });
  }

  test("cannot see a job that is not assigned to them (404), and can once assigned", async ({ page, api, apiAs }) => {
    const name = uniq("Perm Unassigned");
    const job = await api.createJob({ name });

    const res = await page.goto(`/jobs/${job.id}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByText(JOB_NOT_FOUND_TEXT)).toBeVisible();

    const editorApi = await apiAs("editor");
    expect((await editorApi.raw("GET", `/api/jobs/${job.id}`)).status).toBe(404);
    expect(await listByName(editorApi, name)).toHaveLength(0);

    const me = await editorApi.me();
    await api.assignEditor(job.id, me.user.id);

    const after = await page.goto(`/jobs/${job.id}`);
    expect(after?.status()).toBe(200);
    await expect(jobHeading(page)).toContainText(name);
    expect((await listByName(editorApi, name)).map((r) => r.id)).toEqual([job.id]);
  });

  test("never assigns, approves (least of all their own work), asks for changes or manages people", async ({ api, apiAs }) => {
    const ed = await apiAs("editor");
    const me = await ed.me();
    expect(me.user).toMatchObject({ role: "editor", persona: "editor", isAdmin: false, canCreateJobs: false });
    const other = await api.userByEmail(ROLE_EMAILS.editor2);
    const job = await api.createJob({ name: uniq("Perm editor limits"), editorId: me.user.id });
    const v = await ed.version(job.id);
    expect((await ed.raw("POST", `/api/jobs/${job.id}/assign`, { role: "editor", userId: other.id, expectedVersion: v })).status).toBe(403);
    expect((await ed.raw("POST", `/api/jobs/${job.id}/cancel`, { expectedVersion: v, reason: "E2E" })).status).toBe(403);
    await ed.sendForChecking(job.id);
    const v2 = await ed.version(job.id);
    expect((await ed.raw("POST", `/api/jobs/${job.id}/approve`, { expectedVersion: v2 })).status).toBe(403);
    expect((await ed.raw("POST", `/api/jobs/${job.id}/revisions`, { expectedVersion: v2, reason: "x", description: "y" })).status).toBe(403);
    expect((await ed.raw("GET", "/api/settings")).status).toBe(403);
    expect((await ed.raw("POST", "/api/users", { email: `e2e-${Date.now()}@studio.test`, name: "E2E", role: "editor" })).status).toBe(403);
    expect((await ed.raw("POST", "/api/clients", { name: uniq("Editor client") })).status).toBe(403);
    // Jobs they held stay readable after a hand-over, but every action is gone.
    await api.assignEditor(job.id, other.id, "E2E hand over");
    const seen = await ed.job(job.id);
    expect(seen.actions.transitions).toHaveLength(0);
    expect([403, 422]).toContain((await ed.raw("POST", `/api/jobs/${job.id}/submit`, { expectedVersion: seen.job.version })).status);
  });

  test("a job that another editor holds is a 404 unless 'See other editors' jobs' is switched on (read-only)", async ({ api }) => {
    const watcher = await api.inviteUser("editor", "Watcher");
    const holder = await api.inviteUser("editor", "Holder");
    const job = await api.createJob({ name: uniq("Watched"), editorId: holder.user.id });
    const session = await loginApi(watcher.email, watcher.tempPassword);
    expect((await session.raw("GET", `/api/jobs/${job.id}`)).status).toBe(404);
    await api.setPermissions(watcher.user.id, { canViewTeamJobs: true });
    const seen = await session.job(job.id);
    expect(seen.actions.transitions).toHaveLength(0);
    expect((await session.raw("POST", `/api/jobs/${job.id}/comments`, { body: "E2E read-only", mentionUserIds: [] })).status).toBe(403);
    await api.setPermissions(watcher.user.id, { canViewTeamJobs: false });
    expect((await session.raw("GET", `/api/jobs/${job.id}`)).status).toBe(404);
    // Member switches do not exist for editors.
    expect((await api.raw("POST", `/api/users/${watcher.user.id}/permissions`, { canViewAllJobs: true, expectedVersion: await api.userVersion(watcher.user.id) })).status).toBe(422);
    await session.dispose();
  });

  test("'Can add their own jobs': off by default (403 and no New job); on, the editor creates a job for the owner and may take it", async ({ api, pageWithState }) => {
    const editor = await api.inviteUser("editor", "Can add");
    let session = await loginApi(editor.email, editor.tempPassword);
    const { clientId } = await api.createClient("Can add");
    const jobTypeId = await session.jobTypeId();
    expect((await session.raw("POST", "/api/jobs", { name: uniq("Not allowed"), autoProject: { clientId, address: "1 Nope St" }, jobTypeId })).status).toBe(403);
    const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));
    expect((await page.goto("/jobs/new"))?.status()).toBe(403);
    await session.dispose();

    await api.setPermissions(editor.user.id, { canCreateJobs: true });
    session = await loginApi(editor.email, editor.tempPassword);
    const owner = await api.me();
    const job = await session.createJob({ name: uniq("Editor created"), autoProject: { clientId, address: uniq("2 Yes St") }, editorId: editor.user.id });
    expect(job.photographer?.id).toBe(owner.user.id); // the default photographer
    expect(job.editor?.id).toBe(editor.user.id);
    expect(job.statusCategory).toBe("assigned");
    // Another editor as the editor → 403 (assigning is never an editor's).
    const other = await api.userByEmail(ROLE_EMAILS.editor2);
    expect((await session.raw("POST", "/api/jobs", { name: uniq("Editor other"), autoProject: { clientId, address: "3 No St" }, jobTypeId, editorId: other.id })).status).toBe(403);
    expect((await page.goto("/jobs/new"))?.status()).toBe(200);
    await session.dispose();
  });
});

test.describe("tenant isolation", () => {
  test.use({ role: "other-owner" });

  test("another studio's job is a 404 on the page, in the API and absent from lists and search", async ({ page, api, apiAs }) => {
    const name = uniq("Perm Foreign");
    const job = await api.createJob({ name });

    const res = await page.goto(`/jobs/${job.id}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByText(JOB_NOT_FOUND_TEXT)).toBeVisible();

    const other = await apiAs("other-owner");
    for (const url of [`/api/jobs/${job.id}`, `/api/jobs/${job.id}/history`, `/api/jobs/by-number/${job.jobNumber}`]) {
      expect((await other.raw("GET", url)).status, url).toBe(404);
    }
    expect(await listByName(other, name)).toHaveLength(0);
    const search = await other.get<{ jobs: { id: string }[] }>(`/api/search?q=${encodeURIComponent(name)}`);
    expect(search.jobs.map((j) => j.id)).not.toContain(job.id);

    // Mutations are 404 too (never 403 — no existence leak).
    const mut = await other.raw("POST", `/api/jobs/${job.id}/comments`, { body: "hello", mentionUserIds: [] });
    expect(mut.status).toBe(404);
    // The other studio's Editors page never lists Northlight's people.
    expect(JSON.stringify(await other.get<unknown>("/api/users"))).not.toContain(ROLE_EMAILS.editor);
  });
});

test.describe("extra photographer (Only their own shoots)", () => {
  test.use({ role: "photographer" });

  test("has the preset's switches, sees their own job but not the owner's, and never the owner's pages", async ({ page, api, apiAs }) => {
    const p01 = await apiAs("photographer");
    const me = await p01.me();
    expect(me.user).toMatchObject({ persona: "member", isAdmin: false, canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: true, canViewAllJobs: false, canViewTeamWorkloads: false, canViewAnalytics: false });

    const ownName = uniq("Perm Own");
    const foreignName = uniq("Perm Others");
    const own = await api.createJob({ name: ownName, photographerId: me.user.id });
    const others = await api.createJob({ name: foreignName });

    const blocked = await page.goto(`/jobs/${others.id}`);
    expect(blocked?.status()).toBe(404);
    await expect(page.getByText(JOB_NOT_FOUND_TEXT)).toBeVisible();
    expect((await p01.raw("GET", `/api/jobs/${others.id}`)).status).toBe(404);
    expect(await listByName(p01, foreignName)).toHaveLength(0);

    const allowed = await page.goto(`/jobs/${own.id}`);
    expect(allowed?.status()).toBe(200);
    await expect(jobHeading(page)).toContainText(ownName);
    expect((await listByName(p01, ownName)).map((r) => r.id)).toEqual([own.id]);

    // The photographer is forced to self when creating; naming someone else is the owner's (403).
    const ownerId = (await api.me()).user.id;
    const { clientId } = await api.createClient("Perm member");
    expect((await p01.raw("POST", "/api/jobs", { name: uniq("Member for owner"), autoProject: { clientId, address: "1 Owner St" }, jobTypeId: await p01.jobTypeId(), photographerId: ownerId })).status).toBe(403);
    // She checks the edits on her own shoots (decision 4) and can assign editors to them.
    const editor = await api.userByEmail(ROLE_EMAILS.editor);
    const mine = await p01.createJob({ name: uniq("Member checks own"), autoProject: { clientId, address: uniq("2 Mine St") }, editorId: editor.id });
    expect(mine.photographer?.id).toBe(me.user.id);
    const ed = await apiAs("editor");
    await ed.sendForChecking(mine.id);
    expect((await p01.action(mine.id, "approve")).job.statusCategory).toBe("approved");

    for (const path of ["/editors", "/settings/studio", "/settings/people", "/settings/history", "/workspace/kanban", "/insights/analytics"]) {
      const res = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect([403, 404, 200], path).toContain(res?.status());
      if (res?.status() === 200) expect(page.url(), `${path} redirected to a simple page`).toMatch(/\/(jobs|editors|home)/);
      if (path === "/editors") expect(res?.status(), path).not.toBe(200);
    }
    for (const url of ["/api/settings", "/api/analytics/overview", "/api/system/integrity"]) expect([403, 404], url).toContain((await p01.raw("GET", url)).status);
  });
});

test.describe("owner and co-owners", () => {
  test("a photographer becomes a co-owner and back; nobody else can touch the primary owner", async ({ api }) => {
    const ownerId = (await api.me()).user.id;
    const member = await api.inviteUser("photographer", { label: "CoAdmin", preset: "own_shoots" });

    let session = await loginApi(member.email, member.tempPassword);
    expect((await session.me()).user.persona).toBe("member");
    expect((await session.raw("POST", `/api/users/${member.user.id}/admin`, { isAdmin: true, expectedVersion: member.user.version })).status).toBe(403);
    await session.dispose();

    await api.setAdmin(member.user.id, true);
    session = await loginApi(member.email, member.tempPassword);
    const me = await session.me();
    expect(me.user.persona).toBe("admin");
    expect(me.user.isPrimaryOwner).toBe(false);
    expect((await session.raw("GET", "/api/settings")).status).toBe(200);
    expect((await session.pageStatus("/editors")).status).toBe(200);
    // Switches cannot be set on an admin.
    expect((await api.raw("POST", `/api/users/${member.user.id}/permissions`, { canViewAnalytics: false, expectedVersion: await api.userVersion(member.user.id) })).status).toBe(422);

    // Primary-owner protection: the co-owner cannot demote, deactivate, re-email or reset the owner.
    const ownerVersion = await api.userVersion(ownerId);
    for (const [url, body] of [
      [`/api/users/${ownerId}/admin`, { isAdmin: false, expectedVersion: ownerVersion }],
      [`/api/users/${ownerId}/deactivate`, { expectedVersion: ownerVersion, reason: "E2E takeover" }],
      [`/api/users/${ownerId}/reset-password`, { expectedVersion: ownerVersion }],
      [`/api/users/${ownerId}/role`, { role: "editor", expectedVersion: ownerVersion }],
    ] as const) {
      expect([403, 422], url).toContain((await session.raw("POST", url, body)).status);
    }
    expect((await api.me()).user.isPrimaryOwner).toBe(true);
    await session.dispose();

    // The owner can neither revoke their own admin nor deactivate themselves.
    expect([403, 422]).toContain((await api.raw("POST", `/api/users/${ownerId}/admin`, { isAdmin: false, expectedVersion: await api.userVersion(ownerId) })).status);
    expect([403, 422]).toContain((await api.raw("POST", `/api/users/${ownerId}/deactivate`, { expectedVersion: await api.userVersion(ownerId), reason: "E2E self" })).status);

    await api.setAdmin(member.user.id, false);
    session = await loginApi(member.email, member.tempPassword);
    expect((await session.me()).user.persona).toBe("member");
    expect((await session.raw("GET", "/api/settings")).status).toBe(403);
    await session.dispose();

    const events = await eventually(async () => {
      const list = await api.get<{ items: { eventType: string }[] }>("/api/activity?limit=200&eventType=user.admin_changed");
      const hits = list.items.filter((e) => JSON.stringify(e).includes(member.user.id));
      return hits.length >= 2 ? hits : null;
    });
    expect(events.length).toBeGreaterThanOrEqual(2);
    await api.deactivateUser(member.user.id, "E2E co-owner test done");
  });

  test("a client user needs a client with the portal on; never a client without a client or with staff flags", async ({ api }) => {
    const { clientId } = await api.createClient("Invite portal");
    const stamp = Date.now().toString(36);
    expect((await api.raw("POST", "/api/users", { email: `e2e-client-off-${stamp}@studio.test`, name: "E2E Portal Off", role: "client", clientId })).status).toBe(422);
    await api.setClientPortal(clientId, { portalEnabled: true });
    const client = await api.inviteUser("client", { label: "Invite", clientId });
    const login = await loginApi(client.email, client.tempPassword);
    expect((await login.clientMe()).kind).toBe("client");
    await login.dispose();
    expect((await api.raw("POST", "/api/users", { email: `e2e-client-none-${stamp}@studio.test`, name: "E2E No Client", role: "client" })).status).toBe(400);
    expect((await api.raw("POST", "/api/users", { email: `e2e-client-admin-${stamp}@studio.test`, name: "E2E Client Admin", role: "client", clientId, isAdmin: true })).status).toBe(400);
  });

  test("the unused claim endpoint is gone and the scope cookie endpoint with it", async ({ api }) => {
    const job = await api.createJob({ name: uniq("Perm claim gone") });
    expect([404, 405]).toContain((await api.raw("POST", `/api/jobs/${job.id}/claim`, { expectedVersion: 1 })).status);
    expect([404, 405]).toContain((await api.raw("POST", "/api/me/scope", { scope: "mine" })).status);
    // `?scope=` is ignored: the owner always sees everything.
    const rows = await api.get<{ rows: { id: string }[] }>(`/api/jobs?q=${encodeURIComponent(job.name)}&scope=mine`);
    expect(rows.rows.map((r) => r.id)).toContain(job.id);
  });
});
