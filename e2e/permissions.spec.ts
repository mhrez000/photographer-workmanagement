import { uniq, type JobRow } from "./api";
import { expect, jobHeading, test } from "./fixtures";

/**
 * Permissions (spec §40; ARCHITECTURE §3). Pages a role may not open are a real
 * 403; records outside the viewer's org or visibility are a 404 (no existence leak).
 */

const FORBIDDEN_TEXT = "You don't have access to this";
const JOB_NOT_FOUND_TEXT = "We can't find that job";

async function listByName(api: { get: <T>(u: string) => Promise<T> }, name: string): Promise<JobRow[]> {
  const res = await api.get<{ rows: JobRow[] }>(`/api/jobs?q=${encodeURIComponent(name)}&limit=50`);
  return res.rows;
}

test.describe("editor role", () => {
  test.use({ role: "editor" });

  for (const path of ["/settings/organisation", "/settings/users", "/settings/workflows", "/insights/analytics", "/insights/reports"]) {
    test(`is blocked from ${path} with a real 403 page`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(403);
      await expect(page.getByText(FORBIDDEN_TEXT)).toBeVisible();
    });
  }

  test("the sidebar offers neither Insights nor studio settings", async ({ page }) => {
    await page.goto("/dashboard");
    const nav = page.getByRole("navigation").first();
    await expect(nav).toBeVisible();
    await expect(page.locator('a[href^="/insights"]')).toHaveCount(0);
    await expect(page.locator('a[href="/settings/organisation"]')).toHaveCount(0);
  });

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
  });
});

test.describe("photographer without flags", () => {
  test.use({ role: "photographer-noflags" });

  test("sees their own job but not another photographer's", async ({ page, api, apiAs }) => {
    const p02 = await apiAs("photographer-noflags");
    const me = await p02.me();
    // A brand-new photographer is in no team, so team visibility cannot apply.
    const stranger = await api.inviteUser("photographer", "Perm");

    const { projectId } = await api.createClientAndProject("Perm");
    const ownName = uniq("Perm Own");
    const foreignName = uniq("Perm Others");
    const own = await api.createJob({ name: ownName, projectId, photographerId: me.user.id });
    const others = await api.createJob({ name: foreignName, projectId, photographerId: stranger.user.id });

    const blocked = await page.goto(`/jobs/${others.id}`);
    expect(blocked?.status()).toBe(404);
    await expect(page.getByText(JOB_NOT_FOUND_TEXT)).toBeVisible();
    expect((await p02.raw("GET", `/api/jobs/${others.id}`)).status).toBe(404);
    expect(await listByName(p02, foreignName)).toHaveLength(0);

    const allowed = await page.goto(`/jobs/${own.id}`);
    expect(allowed?.status()).toBe(200);
    await expect(jobHeading(page)).toContainText(ownName);
    expect((await listByName(p02, ownName)).map((r) => r.id)).toEqual([own.id]);

    // The All Work table never lists the other photographer's job.
    await page.goto(`/workspace/all?q=${encodeURIComponent(foreignName)}`);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByText(foreignName)).toHaveCount(0);
  });

  test("is blocked from Insights (no analytics flag)", async ({ page }) => {
    const res = await page.goto("/insights/analytics");
    expect(res?.status()).toBe(403);
    await expect(page.getByText(FORBIDDEN_TEXT)).toBeVisible();
  });
});
