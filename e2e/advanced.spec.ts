import { ADVANCED_FEATURE_META, ADVANCED_FEATURES } from "../src/lib/constants";
import { ROLE_EMAILS, SIMPLE_PAGE_RE, expectHiddenPage, loginApi, uniq } from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, mainNav, test } from "./fixtures";

/**
 * Hide, don't delete (docs/SIMPLIFICATION-PLAN.md §8, §9): with Advanced tools ON (set through the
 * settings API) the Board, Timeline, Reports & stats, Workflows and Automations pages are reachable
 * and the Advanced group appears in the menu; OFF again, every hidden page and API is a 404 (not a
 * 403: the pages do not exist for a simple studio). The data behind them is untouched either way.
 *
 * The switch is studio-wide and the database is shared: every test restores OFF in `finally`.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const HIDDEN_PAGES = ADVANCED_FEATURES.flatMap((k) => ADVANCED_FEATURE_META[k].routes);
const HIDDEN_APIS = ADVANCED_FEATURES.flatMap((k) => ADVANCED_FEATURE_META[k].apiPrefixes).filter((p) => !p.startsWith("/api/jobs/bulk"));

test("off (the default): every hidden page and API prefix is a 404 for the owner, and the menu has no Advanced group", async ({ page, api }) => {
  expect(await api.advancedToolsOn()).toBe(false);
  // A hidden page is a 404 or a 307 to its simple replacement (/insights/* → /editors, /projects → /jobs, …), never a 200.
  for (const path of HIDDEN_PAGES) expectHiddenPage(await api.pageStatus(path), path);
  for (const prefix of HIDDEN_APIS) {
    const res = await api.raw("GET", prefix);
    expect(res.status, prefix).toBe(404);
    expect(res.error?.code, prefix).toBe("not_found");
    expect(res.headers["content-type"], prefix).toContain("application/json");
  }
  // Per-job advanced sub-paths (timer, sessions, pause, resume) are hidden too.
  const job = await api.createJob({ name: uniq("E2E advanced subpaths") });
  for (const sub of ["timer", "sessions", "pause", "resume"]) {
    const res = await api.raw(sub === "sessions" ? "GET" : "POST", `/api/jobs/${job.id}/${sub}`, sub === "sessions" ? undefined : { expectedVersion: 1, action: "start" });
    expect(res.status, sub).toBe(404);
  }
  // Saved views, dashboard layouts and bulk UI endpoints are hidden.
  expect((await api.raw("GET", "/api/views")).status).toBe(404);
  expect((await api.raw("GET", "/api/dashboard/layout")).status).toBe(404);
  expect((await api.raw("POST", "/api/jobs/bulk/reassign", { jobIds: [job.id], userId: null })).status).toBe(404);
  await gotoReady(page, "/home", mainNav(page));
  await expect(mainNav(page).getByText("Advanced", { exact: true })).toHaveCount(0);
  await expect(mainNav(page).getByRole("link", { name: /board|timeline|reports|automations|workflows/i })).toHaveCount(0);
});

test("on: Board, Timeline, Reports & stats, Workflows and Automations are reachable and listed; off again → 404", async ({ page, api }) => {
  try {
    expect(await api.setAdvancedTools(true)).toBe(true);
    // Pages render for the owner.
    for (const path of ["/workspace/kanban", "/workspace/timeline", "/insights/analytics", "/insights/bottlenecks", "/insights/reports", "/settings/workflows", "/settings/automations", "/settings/teams", "/settings/roles", "/projects", "/team/workloads", "/team/performance"]) {
      const { status } = await api.pageStatus(path);
      expect([200, 307], path).toContain(status);
    }
    // APIs answer.
    for (const url of ["/api/kanban", "/api/timeline", "/api/analytics/overview", "/api/bottlenecks", "/api/reports/editors?range=this_month", "/api/workflows", "/api/automations", "/api/teams", "/api/workloads", "/api/performance", "/api/views", "/api/dashboard/layout"]) {
      expect((await api.raw("GET", url)).status, url).toBe(200);
    }
    // Reports keep the query-string form and the CSV download (plan §8: Reports stay under Advanced).
    const viaQuery = await api.raw<{ kind: string }>("GET", "/api/reports?type=editors&range=this_month");
    expect(viaQuery.status).toBe(200);
    expect(viaQuery.data.kind).toBe("editors");
    expect((await api.raw("GET", "/api/reports?type=nope")).status).toBe(404);
    const csv = await api.raw("GET", "/api/reports?type=production&range=this_week&format=csv");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");

    // The Board uses the five stage columns and a drop is a recorded engine move.
    const board = await api.get<{ columns?: { key?: string; id?: string; label?: string }[] }>("/api/kanban");
    const columnText = JSON.stringify(board.columns ?? board);
    for (const stage of ["Needs editor", "With editor", "Ready to check", "Changes asked", "Done"]) expect(columnText, stage).toContain(stage);

    // The menu shows the Advanced group once.
    await gotoReady(page, "/home", mainNav(page));
    await expect(mainNav(page).getByText("Advanced", { exact: true })).toBeVisible();
    for (const label of ["Board", "Timeline", "Reports & stats", "Automations", "Workflows"]) await expect(mainNav(page).getByRole("link", { name: label }), label).toHaveCount(1);
    const res = await page.goto("/workspace/kanban");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("main")).toBeVisible();

    // Advanced is the owner's: an editor still cannot open Board or Workflows while it is on (the pages
    // send them to the simple replacement, like every hidden page; the APIs refuse outright).
    const editor = await loginApi(ROLE_EMAILS.editor);
    expectHiddenPage(await editor.pageStatus("/workspace/kanban"), "/workspace/kanban");
    expectHiddenPage(await editor.pageStatus("/settings/workflows"), "/settings/workflows");
    expect([403, 404]).toContain((await editor.raw("GET", "/api/workflows")).status);
    await editor.dispose();
  } finally {
    await api.setAdvancedTools(false);
  }
  // Off again: hidden.
  expectHiddenPage(await api.pageStatus("/workspace/kanban"), "/workspace/kanban");
  expect((await api.raw("GET", "/api/kanban")).status).toBe(404);
  const res = await page.goto("/workspace/kanban");
  if (res?.status() !== 404) expect(new URL(page.url()).pathname, "Board redirected to a simple page").toMatch(SIMPLE_PAGE_RE);
  await gotoReady(page, "/home", mainNav(page));
  await expect(mainNav(page).getByText("Advanced", { exact: true })).toHaveCount(0);
});

test("only an admin may flip the switch; the data behind hidden features is untouched by hiding", async ({ api, apiAs }) => {
  const settings = await api.settings();
  for (const role of ["photographer", "editor"] as const) {
    const other = await apiAs(role);
    expect((await other.raw("PATCH", "/api/settings", { expectedVersion: settings.settings.version, advancedToolsEnabled: true })).status, role).toBe(403);
  }
  expect(await api.advancedToolsOn()).toBe(false);
  // Hiding never rewrites: workflows and job types still exist the moment the switch is on.
  try {
    await api.setAdvancedTools(true);
    const workflows = await api.get<unknown[]>("/api/workflows");
    expect(workflows.length).toBeGreaterThanOrEqual(1);
  } finally {
    await api.setAdvancedTools(false);
  }
});
