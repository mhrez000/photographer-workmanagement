import type { Page } from "@playwright/test";
import { ROLE_NAMES, expectHiddenPage, loginApi } from "./api";
import { UI_TEST_TIMEOUT, accountMenuButton, expect, expectPlainWords, gotoReady, mainNav, mainNavLabels, retrying, storageFor, test } from "./fixtures";

/**
 * Navigation per role (docs/SIMPLIFICATION-PLAN.md §2, §3): the owner has five items (Home · Jobs ·
 * Editors · Clients · Settings), an extra photographer three (Home · Jobs · Clients), an editor two
 * (My jobs · Calendar), and the client portal keeps Your work · Notifications · Account. The topbar
 * is Search, + New job, the bell and the avatar menu (My account · Help · Log out); the scope switch
 * is gone. Hidden pages are not only off the menu: they are blocked on the server.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

async function openAccountMenu(page: Page) {
  const menu = page.getByRole("menu", { name: "Account" });
  await retrying(async () => {
    if (!(await menu.isVisible())) await accountMenuButton(page).click({ timeout: 5_000 });
    await expect(menu).toBeVisible({ timeout: 3_000 });
  });
  return menu;
}

async function expectTopbar(page: Page, opts: { newJob: boolean }) {
  const banner = page.getByRole("banner");
  await expect(banner.getByRole("button", { name: /search/i }).or(banner.getByRole("link", { name: /search/i })).first()).toBeVisible();
  await expect(banner.getByRole("link", { name: /^notifications/i })).toBeVisible();
  await expect(accountMenuButton(page)).toBeVisible();
  await expect(banner.getByText(/whole business|my shoots/i)).toHaveCount(0);
  const newJob = banner.getByRole("link", { name: /new job/i });
  if (opts.newJob) await expect(newJob).toBeVisible();
  else await expect(newJob).toHaveCount(0);
  const menu = await openAccountMenu(page);
  for (const item of ["My account", "Help", "Log out"]) await expect(menu.getByRole("menuitem", { name: item }), item).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /your profile|shortcuts|appearance/i })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

test("owner: Home · Jobs · Editors · Clients · Settings, + New job, and every page opens", async ({ page, api }) => {
  await gotoReady(page, "/home", mainNav(page));
  expect(await mainNavLabels(page)).toEqual(["Home", "Jobs", "Editors", "Clients", "Settings"]);
  await expect(mainNav(page).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await expectTopbar(page, { newJob: true });
  await expectPlainWords(page, "/home");
  for (const [label, path] of [
    ["Jobs", "/jobs"],
    ["Editors", "/editors"],
    ["Clients", "/clients"],
    ["Settings", "/settings/studio"],
    ["Home", "/home"],
  ] as const) {
    await retrying(async () => {
      await mainNav(page).getByRole("link", { name: label }).click({ timeout: 5_000 });
      await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`), { timeout: 15_000 });
    });
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByText(/you don't have access/i)).toHaveCount(0);
  }
  // Advanced tools is off: no Advanced group, and the hidden pages are 404 for the owner too.
  await expect(mainNav(page).getByText("Advanced", { exact: true })).toHaveCount(0);
  for (const path of ["/workspace/kanban", "/workspace/timeline", "/settings/workflows", "/settings/automations", "/settings/teams", "/settings/roles", "/settings/appearance"]) {
    expectHiddenPage(await api.pageStatus(path), path);
  }
  // The owner's Home has none of the old dashboard (plan §6 "Removed from Home").
  await gotoReady(page, "/home", mainNav(page));
  for (const gone of [/customise/i, /recent activity/i, /turnaround/i, /revision rate/i, /key numbers/i]) await expect(page.getByRole("main").getByText(gone), `${gone}`).toHaveCount(0);
});

test("extra photographer: Home · Jobs · Clients; no Editors or Settings; Editors / Settings pages are refused", async ({ pageAs, apiAs }) => {
  const page = await pageAs("photographer");
  await gotoReady(page, "/home", mainNav(page));
  expect(await mainNavLabels(page)).toEqual(["Home", "Jobs", "Clients"]);
  await expectTopbar(page, { newJob: true });
  // Home: same layout minus "Your editors".
  await expect(page.getByRole("main").getByRole("heading", { name: /your editors/i })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toContainText(new RegExp(`(Good (morning|afternoon|evening)|Working late), ${ROLE_NAMES.photographer!.split(" ")[0]}`));
  const api = await apiAs("photographer");
  for (const path of ["/editors", "/settings/studio", "/settings/people", "/settings/history"]) {
    expect([403, 404], path).toContain((await api.pageStatus(path)).status);
  }
  expect((await api.raw("GET", "/api/settings")).status).toBe(403);
  // Clients: only the clients on her jobs (plan §3).
  expect((await api.pageStatus("/clients")).status).toBe(200);
});

test("editor: My jobs · Calendar only; no New job; Jobs, Clients, Home, Editors and Settings are closed", async ({ pageAs, apiAs }) => {
  const page = await pageAs("editor");
  await gotoReady(page, "/my-jobs", mainNav(page));
  expect(await mainNavLabels(page)).toEqual(["My jobs", "Calendar"]);
  await expectTopbar(page, { newJob: false });
  const api = await apiAs("editor");
  for (const path of ["/home", "/jobs", "/clients", "/editors", "/settings/studio", "/settings/people", "/settings/history", "/projects", "/workspace/kanban"]) {
    const { status } = await api.pageStatus(path);
    expect([403, 404, 307], path).toContain(status);
    if (status === 307) {
      const { location } = await api.pageStatus(path);
      expect(location, path).toMatch(/\/my-jobs|\/jobs|\/editors/);
    }
  }
  // Calendar: their own due dates.
  await retrying(async () => {
    await mainNav(page).getByRole("link", { name: "Calendar" }).click({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/calendar/, { timeout: 15_000 });
  });
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("main").getByText(/all work|team work|whole business/i)).toHaveCount(0);
});

test("a co-owner gets the owner's menu minus Transfer ownership; an editor who can add jobs gets + New job", async ({ api, pageWithState }) => {
  const co = await api.inviteUser("photographer", { label: "Nav co-owner", preset: "co_owner" });
  const coPage = await pageWithState(await storageFor(co.email, co.tempPassword));
  await gotoReady(coPage, "/home", mainNav(coPage));
  expect(await mainNavLabels(coPage)).toEqual(["Home", "Jobs", "Editors", "Clients", "Settings"]);
  await gotoReady(coPage, "/settings/studio", coPage.getByRole("main"));
  await expect(coPage.getByRole("main").getByText(/transfer ownership/i)).toHaveCount(0);

  const creator = await api.inviteUser("editor", { label: "Nav creator", flags: { canCreateJobs: true } });
  const edPage = await pageWithState(await storageFor(creator.email, creator.tempPassword));
  await gotoReady(edPage, "/my-jobs", mainNav(edPage));
  expect(await mainNavLabels(edPage)).toEqual(["My jobs", "Calendar"]);
  await expect(edPage.getByRole("banner").getByRole("link", { name: /new job/i })).toBeVisible();
  const session = await loginApi(creator.email, creator.tempPassword);
  expect((await session.pageStatus("/jobs/new")).status).toBe(200);
  await session.dispose();
});

test("client portal: Your work · Notifications · Account, and nothing of the staff shell", async ({ pageAs, apiAs }) => {
  const page = await pageAs("client");
  await gotoReady(page, "/portal", page.getByRole("heading", { name: "Your work" }));
  // The portal header: Your work · Notifications (bell) · Account (avatar menu) — unchanged (plan §3).
  const nav = page.getByRole("navigation", { name: "Portal" });
  await expect(nav.getByRole("link", { name: /^(your|shared) work$/i })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^notifications/i })).toBeVisible();
  await expect(nav.getByRole("button", { name: /^account menu for/i })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /new job|^jobs$|editors/i })).toHaveCount(0);
  await expect(page.getByRole("banner")).toContainText("Harbourline Realty");
  const api = await apiAs("client");
  for (const path of ["/home", "/jobs", "/my-jobs", "/editors", "/settings/studio"]) expect((await api.pageStatus(path)).location, path).toMatch(/\/portal$/);
});
