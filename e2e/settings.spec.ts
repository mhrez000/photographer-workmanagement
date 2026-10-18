import type { Page } from "@playwright/test";
import { ROLE_EMAILS, civilDate, expectHiddenPage, loginApi, newApi, uniq } from "./api";
import { UI_TEST_TIMEOUT, dialogButton, expect, expectPlainWords, gotoReady, mainNav, mainNavLabels, retrying, test } from "./fixtures";

/**
 * Settings (docs/SIMPLIFICATION-PLAN.md §3, §8, §9, §10 phase 4): ONE entry with tabs (Studio ·
 * People · Types of shoot · My account · History); inviting a photographer offers one choice
 * ("Only their own shoots" / "Everything (co-owner)") and an editor "Can add their own jobs"; the
 * Advanced tools switch shows / hides the Advanced group and makes the hidden pages 404; and
 * "Close delivered jobs" runs the normal recorded steps one job at a time.
 *
 * The Advanced switch is studio-wide and the database is shared: every test that flips it
 * restores "off" in `finally`.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const TABS = ["Studio", "People", "Types of shoot", "My account", "History"] as const;

/** The Settings tab strip (`<nav aria-label="Settings">`, plain links). */
function settingsTabs(page: Page) {
  return page.getByRole("main").getByRole("navigation", { name: "Settings" });
}

test("one Settings entry with five tabs; the old 8-item sidebar and duplicate Notifications item are gone", async ({ page }) => {
  await gotoReady(page, "/settings/studio", settingsTabs(page));
  await expectPlainWords(page, "/settings/studio");
  const labels = (await settingsTabs(page).getByRole("link").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels).toEqual([...TABS]);
  // One Settings item in the main menu, pointing at Studio.
  const nav = mainNav(page);
  await expect(nav.getByRole("link", { name: "Settings" })).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings/studio");
  await expect(nav.getByRole("link", { name: /notifications|workflows|automations|teams|roles/i })).toHaveCount(0);

  // Each tab is a page of its own, named in the topbar.
  for (const [label, path] of [
    ["People", "/settings/people"],
    ["Types of shoot", "/settings/shoot-types"],
    ["My account", "/settings/account"],
    ["History", "/settings/history"],
  ] as const) {
    await retrying(async () => {
      await settingsTabs(page).getByRole("link", { name: label }).click({ timeout: 5_000 });
      await expect(page).toHaveURL(new RegExp(path), { timeout: 10_000 });
    });
    await expect(page.getByRole("banner")).toContainText(label);
    await expect(settingsTabs(page).getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  }
  // Studio: name, timezone, job number prefix — and the Advanced tools switch (off).
  await gotoReady(page, "/settings/studio", page.getByRole("main").getByRole("switch", { name: /advanced tools/i }));
  const main = page.getByRole("main");
  for (const field of [/studio name/i, /^timezone/i, /job number prefix/i]) await expect(main.getByText(field).first()).toBeVisible();
  await expect(main.getByRole("switch", { name: /advanced tools/i })).toHaveAttribute("aria-checked", "false");
});

test("People: plain cards; inviting a photographer offers the one choice, an editor 'Can add their own jobs'", async ({ page, api }) => {
  await gotoReady(page, "/settings/people", page.getByRole("main").getByText(/Photographer · only their own shoots/i).first());
  const main = page.getByRole("main");
  // Three role cards; each person wears a plain label (Owner · Photographer · only their own shoots · Editor); no six-switch table.
  for (const card of ["Photographers", "Editors", "Clients"]) await expect(main.getByRole("link", { name: new RegExp("^" + card + "\\b") }), card).toBeVisible(); // the cards filter the list
  await expect(main.getByText("Owner", { exact: true }).first()).toBeVisible();
  await expect(main.getByText(/Photographer · only their own shoots/i).first()).toBeVisible();
  await expect(main.getByText(/^Editor( · adds own jobs)?$/).first()).toBeVisible();
  await expect(main.getByText(/See all jobs|View team workloads|View analytics|capacity/i)).toHaveCount(0);
  // A person's page: the editor's one switch, "Can add their own jobs"; the photographer's one choice.
  const sam = await api.userByEmail(ROLE_EMAILS.editor);
  await gotoReady(page, `/settings/people/${sam.id}`, main.getByText(/Can add their own jobs/i).first());
  await expect(main.getByRole("switch", { name: /can add their own jobs/i })).toBeVisible();
  await expect(main.getByText(/Usually handles up to/i).first()).toBeVisible();
  const priya = await api.userByEmail(ROLE_EMAILS.photographer);
  await gotoReady(page, `/settings/people/${priya.id}`, main.getByRole("radio", { name: /^Only their own shoots/ }));
  await expect(main.getByRole("radio", { name: /^Only their own shoots/ })).toHaveAttribute("aria-checked", "true");
  await expect(main.getByRole("radio", { name: /^Everything \(co-owner\)/ })).toBeVisible();

  // Invite: ?invite=1 opens the dialog (plan §3 quick action).
  await gotoReady(page, "/settings/people?invite=1", page.getByRole("dialog"));
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /invite someone/i })).toBeVisible();
  const roles = dialog.getByRole("radiogroup", { name: "Role" });
  for (const role of [/^Photographer/, /^Editor/, /^Client/]) await expect(roles.getByRole("radio", { name: role })).toBeVisible();
  await roles.getByRole("radio", { name: /^Photographer/ }).click();
  const access = dialog.getByRole("radiogroup", { name: /photographer access/i });
  await expect(access.getByRole("radio", { name: /^Only their own shoots/ })).toBeVisible();
  await expect(access.getByRole("radio", { name: /^Everything \(co-owner\)/ })).toBeVisible();
  // The hidden per-switch rows, avatar colour, title and capacity are not on the invite (plan §8).
  await expect(dialog.getByText(/capacity|avatar colour|see all jobs/i)).toHaveCount(0);
  await roles.getByRole("radio", { name: /^Editor/ }).click();
  const canAdd = dialog.getByRole("checkbox", { name: /can add their own jobs/i });
  await expect(canAdd).toBeVisible();
  await expect(canAdd).not.toBeChecked();

  // Invite an editor through the dialog (front door): the default is an invite LINK, shown once with
  // Copy link; the person opens it, chooses a password and signs in. Until then they are "Invite pending".
  const stamp = Date.now().toString(36);
  const email = `e2e-invite-${stamp}@studio.test`;
  await dialog.getByRole("textbox", { name: /full name/i }).fill(`E2E Invited ${stamp}`);
  await dialog.getByRole("textbox", { name: /email/i }).fill(email);
  await expect(dialog.getByRole("button", { name: /set a temporary password instead/i })).toBeVisible();
  await dialogButton(page, /^invite$/i).click();
  const link = dialog.locator('code[aria-label="Invite link"]');
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole("button", { name: /copy link/i })).toBeVisible();
  const inviteUrl = (await link.innerText()).trim();
  const token = inviteUrl.split("/invite/")[1];
  expect(token, inviteUrl).toBeTruthy();
  const invited = await api.userByEmail(email);
  expect(invited.role).toBe("editor");
  const anon = await newApi();
  try {
    // Not accepted yet: login is refused with the generic 401, and the public lookup says the link is live.
    expect((await anon.raw("POST", "/api/auth/login", { email, password: "Password123!" })).status).toBe(401);
    expect((await anon.get<{ valid: boolean; email: string }>(`/api/auth/invite/${token}`)).email).toBe(email);
    await dialogButton(page, /^done$/i).click();
    await expect(page.getByRole("main").getByText(/Invite pending/i).first()).toBeVisible();
    // Accept: choose a password through the link, then sign in with it.
    const accepted = await anon.raw<{ user: { role: string } }>("POST", `/api/auth/invite/${token}/accept`, { password: `E2e-${stamp}-pass!` });
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(200);
  } finally {
    await anon.dispose();
  }
  const session = await loginApi(email, `E2e-${stamp}-pass!`);
  expect((await session.me()).user.canCreateJobs).toBe(false);
  await session.dispose();

  // Presets through the API agree with the cards (plan §2).
  const own = await api.inviteUser("photographer", { label: "Own shoots", preset: "own_shoots" });
  const ownSession = await loginApi(own.email, own.tempPassword);
  expect((await ownSession.me()).user).toMatchObject({ isAdmin: false, canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: true, canViewAllJobs: false });
  await ownSession.dispose();
  const co = await api.inviteUser("photographer", { label: "Co-owner", preset: "co_owner" });
  const coSession = await loginApi(co.email, co.tempPassword);
  expect((await coSession.me()).user).toMatchObject({ isAdmin: true, persona: "admin", isPrimaryOwner: false });
  await coSession.dispose();
  await gotoReady(page, "/settings/people", page.getByRole("main").getByText(own.user.name).first()); // name + avatar initials
  await expect(page.getByRole("main").getByText(co.user.name).first()).toBeVisible();
});

test("Advanced tools switch: on shows the Advanced group and unhides the pages; off makes them 404 again", async ({ page, api }) => {
  expect(await api.advancedToolsOn(), "the shared demo runs with Advanced tools OFF").toBe(false);
  const toggle = page.getByRole("main").getByRole("switch", { name: /advanced tools/i });
  try {
    await gotoReady(page, "/settings/studio", toggle);
    await expect(mainNav(page).getByText("Advanced", { exact: true })).toHaveCount(0);
    expectHiddenPage(await api.pageStatus("/workspace/kanban"), "/workspace/kanban");
    expect((await api.raw("GET", "/api/kanban")).status).toBe(404);

    await retrying(async () => {
      if (!(await api.advancedToolsOn())) await toggle.click({ timeout: 5_000 });
      await expect.poll(() => api.advancedToolsOn(), { timeout: 8_000 }).toBe(true);
    });
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(mainNav(page).getByText("Advanced", { exact: true })).toBeVisible();
    for (const label of ["Board", "Timeline", "Reports & stats", "Automations", "Workflows"]) await expect(mainNav(page).getByRole("link", { name: label }), label).toBeVisible();
    expect(await mainNavLabels(page)).toEqual(["Home", "Jobs", "Editors", "Clients", "Settings", "Board", "Timeline", "Reports & stats", "Automations", "Workflows"]);
    for (const path of ["/workspace/kanban", "/workspace/timeline", "/insights/analytics", "/settings/workflows", "/settings/automations"]) {
      expect((await api.pageStatus(path)).status, path).toBe(200);
    }
    expect((await api.raw("GET", "/api/kanban")).status).toBe(200);

    await retrying(async () => {
      if (await api.advancedToolsOn()) await toggle.click({ timeout: 5_000 });
      await expect.poll(() => api.advancedToolsOn(), { timeout: 8_000 }).toBe(false);
    });
    await page.reload();
    await expect(mainNav(page).getByText("Advanced", { exact: true })).toHaveCount(0);
    expect(await mainNavLabels(page)).toEqual(["Home", "Jobs", "Editors", "Clients", "Settings"]);
    for (const path of ["/workspace/kanban", "/workspace/timeline", "/settings/workflows", "/settings/automations", "/settings/teams", "/settings/roles"]) {
      expectHiddenPage(await api.pageStatus(path), path);
    }
    const res = await api.raw("GET", "/api/kanban");
    expect(res.status).toBe(404);
    expect(res.error?.code).toBe("not_found");
    // The switch is audited.
    const feed = await api.get<{ items: { eventType: string; newValue: unknown }[] }>("/api/activity?limit=50&eventType=settings.updated");
    expect(feed.items.some((e) => JSON.stringify(e.newValue).includes("advancedToolsEnabled"))).toBe(true);
  } finally {
    await api.setAdvancedTools(false);
  }
});

test("Types of shoot: name, colour and usual days to edit; the New job due date follows it", async ({ page, api }) => {
  await gotoReady(page, "/settings/shoot-types", page.getByRole("main").getByText("Real Estate").first());
  const main = page.getByRole("main");
  await expect(main.getByText(/usual days|days to edit|next day|same day|\d+ days/i).first()).toBeVisible();
  await expect(main.getByText(/estimated hours|workflow/i)).toHaveCount(0);
  // Wedding has 21 usual days in the small demo (small.ts): a wedding shot today is due 21 days later.
  const types = await api.get<{ id: string; name: string }[]>("/api/job-types");
  const wedding = types.find((t) => t.name === "Wedding");
  expect(wedding, "Wedding type is seeded").toBeTruthy();
  const job = await api.createJob({ name: uniq("E2E Wedding default due"), jobTypeId: wedding!.id, shootDate: civilDate(0) });
  expect(job.shootDate?.slice(0, 10)).toBe(civilDate(0));
  // The due date is derived from the shoot date + usual days when the client omits it.
  expect(job.dueDate, "a default due date is set from the usual days").toBeTruthy();
});

test("Close delivered jobs: owner-confirmed, each Approved / Delivered job is completed through its own recorded step", async ({ page, api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const ed = await apiAs("editor");
  const approvedOnly = await api.createJob({ name: uniq("E2E close approved"), editorId: editor.id, dueDate: civilDate(1) });
  await ed.sendForChecking(approvedOnly.id);
  await api.approve(approvedOnly.id, "only");
  expect((await api.job(approvedOnly.id)).job.statusCategory).toBe("approved");

  const button = page.getByRole("main").getByRole("button", { name: /close delivered jobs/i });
  await gotoReady(page, "/settings/studio", button);
  await expect(page.getByRole("main")).toContainText(/\d+ jobs? (is|are) delivered but not closed/i);
  const dialog = page.getByRole("dialog");
  await retrying(async () => {
    if (!(await dialog.isVisible())) await button.click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 3_000 });
  });
  await expect(dialog).toContainText(/recorded in its history/i);
  await dialogButton(page, /^close them$/i).click();
  const closed = await api.waitForCategory(approvedOnly.id, "completed", 60_000);
  expect(closed.job.completedAt).toBeTruthy();
  // A normal engine move: its own history row, not a bulk update.
  const history = await api.history(approvedOnly.id);
  expect(history.some((h) => h.kind === "stage" && h.stage?.toCategory === "completed")).toBe(true);
  expect(history.some((h) => h.event?.eventType === "job.completed")).toBe(true);
});

test("History: the studio-wide audit log lives under Settings and filters by job number", async ({ page, api }) => {
  const job = await api.createJob({ name: uniq("E2E history filter"), priority: "normal" });
  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), priority: "urgent" });
  await gotoReady(page, `/settings/history?job=${job.jobNumber}`, page.getByRole("main").getByText(/showing the history of/i));
  const feed = page.getByRole("main");
  await expect(feed.getByRole("listitem").filter({ hasText: /rush|urgent|priority/i }).first()).toBeVisible();
  await expect(feed.getByRole("listitem").filter({ hasText: /PJ-\d+/ }).filter({ hasNotText: job.jobNumber })).toHaveCount(0);
  await expect(feed.getByRole("link", { name: /download csv/i })).toBeVisible();
  // /activity redirects here.
  const { status, location } = await api.pageStatus("/activity");
  expect(status).toBe(307);
  expect(location).toMatch(/\/settings\/history$/);
});
