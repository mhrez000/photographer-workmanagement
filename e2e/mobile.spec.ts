import type { Page } from "@playwright/test";
import { ROLE_EMAILS, civilDate, loginApi, uniq, uniqUrl } from "./api";
import {
  UI_TEST_TIMEOUT,
  clickUntilCategory,
  expect,
  expectInsideViewportX,
  expectInsideViewportY,
  expectNoHorizontalOverflow,
  gotoReady,
  jobHeading,
  nextStepCard,
  retrying,
  stagePill,
  storageFor,
  tabBar,
  test,
} from "./fixtures";

/**
 * Phones first (docs/SIMPLIFICATION-PLAN.md §3 "Phone tabs", §5 side column "below the content on
 * phones", §6): at 390×844 with touch — Home, Jobs, a job page with its next step pinned in reach,
 * and the editor's My jobs. Nothing scrolls sideways and navigation is the bottom tab bar:
 * owner Home · Jobs · (+) New job · Editors · More; editor My jobs · Calendar · Search · Me.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

async function expectTabs(page: Page, labels: string[]) {
  const bar = tabBar(page);
  await expect(bar).toBeVisible();
  const items = bar.locator("a, button");
  // The Home tab carries a count badge ("Home, 5 to check") and the (+) tab is icon-only (aria-label):
  // compare the accessible label part only.
  const texts = await items.evaluateAll((els) => els.map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").replace(/,.*$/, "").replace(/\s*\d+$/, "").trim()));
  expect(texts).toEqual(labels);
  for (const label of labels) {
    const item = bar.getByRole("link", { name: label }).or(bar.getByRole("button", { name: label })).first();
    await expectInsideViewportX(page, item, `${label} tab`);
  }
  const box = await bar.boundingBox();
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBeGreaterThanOrEqual(844 - 1);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
}

test("owner Home: top line, Ready to check cards, the five tabs, (+) New job, More opens Clients and Settings", async ({ page, api, apiAs }) => {
  expect(page.viewportSize()?.width).toBe(390);
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("E2E mobile home"), editorId: editor.id, dueDate: civilDate(2) });
  await (await apiAs("editor")).sendForChecking(job.id);

  await gotoReady(page, "/home", page.getByRole("main").getByRole("heading", { level: 1 }));
  await expectNoHorizontalOverflow(page);
  await expectTabs(page, ["Home", "Jobs", "New job", "Editors", "More"]);
  await expect(tabBar(page).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  // The Home tab carries the red "to check" count.
  await expect(tabBar(page).getByRole("link", { name: "Home" })).toContainText(/\d+/);

  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: /\d+ to check/ })).toBeVisible();
  // Home lists the oldest 20 waiting checks (the shared demo accumulates older ones): the card we measure is
  // ours when it is there, otherwise the first one — every Ready to check card has the same three controls.
  const ready = main.getByRole("region", { name: /^ready to check/i }).or(main.getByRole("heading", { name: /^ready to check/i }).locator("xpath=ancestor::section[1]")).first();
  const ours = ready.getByRole("listitem").filter({ hasText: job.name }).first();
  await expect(ready.getByRole("listitem").first()).toBeVisible();
  const card = (await ours.isVisible().catch(() => false)) ? ours : ready.getByRole("listitem").first();
  await expectInsideViewportX(page, card, "Ready to check card");
  for (const name of [/open finished photos/i, /^approve$/i, /ask for changes/i]) {
    const control = card.getByRole("button", { name }).or(card.getByRole("link", { name })).first();
    await expect(control).toBeVisible();
    await expectInsideViewportX(page, control, `${name} control`);
  }

  // (+) is the raised primary tab → New job.
  await retrying(async () => {
    await tabBar(page).getByRole("link", { name: "New job" }).click({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/jobs\/new/, { timeout: 15_000 });
  });
  await expectNoHorizontalOverflow(page);
  await expect(page.getByRole("main").locator("form").first()).toBeVisible();

  // More: Clients and Settings in the drawer, inside the viewport.
  await retrying(async () => {
    if (!(await page.getByRole("dialog", { name: "More" }).isVisible())) await tabBar(page).getByRole("button", { name: "More" }).click({ timeout: 5_000 });
    await expect(page.getByRole("dialog", { name: "More" })).toBeVisible({ timeout: 3_000 });
  });
  const drawer = page.getByRole("dialog", { name: "More" });
  // One control for one thing: the tab bar's More replaces the topbar hamburger on phones (UX-09).
  await expect(page.getByRole("banner").getByRole("button", { name: /open navigation/i })).toHaveCount(0);
  // The role chip never repeats itself ("Editor · Editor").
  await expect(drawer.getByText(/^(.+) · \1$/)).toHaveCount(0);
  await expect(drawer.getByRole("link", { name: "Clients" })).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(drawer.getByRole("link", { name: /all work|team work|kanban|board/i })).toHaveCount(0);
  await expect.poll(async () => Math.round((await drawer.boundingBox())?.x ?? -999)).toBeGreaterThanOrEqual(0);
  await expectInsideViewportX(page, drawer, "navigation drawer");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("Jobs on a phone: stage tabs scroll sideways inside their strip, rows fit, Late filter works", async ({ page, api }) => {
  const term = uniq("E2E mobile jobs");
  await api.createJob({ name: `${term} late`, editorId: (await api.userByEmail(ROLE_EMAILS.editor)).id, dueDate: civilDate(-1) });
  await api.createJob({ name: `${term} fine`, dueDate: civilDate(3) });
  await gotoReady(page, `/jobs?q=${encodeURIComponent(term)}`, page.getByRole("main").getByRole("navigation", { name: "Stages" }));
  await expectNoHorizontalOverflow(page);
  await expect(tabBar(page).getByRole("link", { name: "Jobs" })).toHaveAttribute("aria-current", "page");
  const main = page.getByRole("main");
  await expect(main.getByText(`${term} late`).locator("visible=true")).toBeVisible(); // the phone card list (the table is hidden)
  await expectInsideViewportX(page, main.getByRole("listitem").filter({ hasText: `${term} late` }).first(), "job card");
  const late = main.getByRole("switch", { name: /^late/i });
  await retrying(async () => {
    await late.click({ timeout: 5_000 });
    await expect(page).toHaveURL(/late=1/, { timeout: 10_000 });
  });
  await expect(main.getByText(`${term} fine`)).toHaveCount(0);
  await expect(main.getByText(`${term} late`).locator("visible=true")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("job page on a phone: header, pinned next step within reach, side column below the content", async ({ page, api }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("E2E mobile job"), editorId: editor.id, dueDate: civilDate(2), description: "Lift the exteriors." });
  await api.addLink(job.id, "raw_files", uniqUrl("raw"), "Raw files");
  for (let i = 0; i < 6; i += 1) await api.addComment(job.id, `E2E padding message ${i} so the page scrolls on a phone.`);

  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  await expectNoHorizontalOverflow(page);
  await expect(stagePill(page)).toBeVisible();
  await expect(page.getByRole("main").getByText("Waiting on:", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("tablist")).toHaveCount(0);

  // The next step's main button is on screen without scrolling, and stays reachable after a scroll.
  const button = nextStepCard(page).getByRole("button", { name: /change editor/i }).first();
  await expect(button).toBeVisible();
  await expectInsideViewportX(page, button, "Change editor");
  await expectInsideViewportY(page, button, "Change editor");
  await page.mouse.wheel(0, 1200);
  await page.evaluate(() => window.scrollBy(0, 1200));
  await expect(button).toBeVisible();
  await expectInsideViewportY(page, button, "Change editor after scrolling");

  // The side column (Shoot date, Due date, Type of shoot, Client can see this job) sits below the content.
  const side = page.getByRole("main").getByText(/client can see this job/i).first();
  await expect(side).toBeAttached();
  const sideBox = await side.boundingBox();
  const headingBox = await jobHeading(page).boundingBox();
  expect((sideBox?.y ?? 0) + (await page.evaluate(() => window.scrollY))).toBeGreaterThan((headingBox?.y ?? 0) + (await page.evaluate(() => window.scrollY)));
  await expectNoHorizontalOverflow(page);
});

test("editor on a phone: My jobs cards fit, one button each, Start editing then Send for checking; tabs My jobs · Calendar · Search · Me", async ({ api, pageWithState }) => {
  const editor = await api.inviteUser("editor", "Mobile");
  const name = uniq("E2E mobile editor");
  const job = await api.createJob({ name, editorId: editor.user.id, dueDate: civilDate(2) });
  await api.addLink(job.id, "raw_files", uniqUrl("raw"), "Raw files");
  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  const session = await loginApi(editor.email, editor.tempPassword);

  await gotoReady(page, "/my-jobs", page.getByRole("main").getByText(name).first()); // "Next up: <name>" and the card
  await expectNoHorizontalOverflow(page);
  await expectTabs(page, ["My jobs", "Calendar", "Search", "Me"]);
  const card = page.getByRole("main").getByRole("listitem").filter({ hasText: name }).first();
  await expectInsideViewportX(page, card, "My jobs card");
  await expect(card.getByRole("link", { name: /raw files/i })).toBeVisible();
  const start = card.getByRole("button", { name: /^start editing$/i });
  await expect(start).toBeVisible();
  await expect(card.getByRole("button", { name: /^send for checking$/i })).toHaveCount(0);
  await clickUntilCategory(page, start, api, job.id, "in_progress");

  // Open it: the job page is readable and its button is reachable with a thumb.
  await retrying(async () => {
    await card.getByRole("link", { name: new RegExp(name) }).first().click({ timeout: 5_000 });
    await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}`), { timeout: 15_000 });
  });
  await expect(jobHeading(page)).toContainText(name);
  await expectNoHorizontalOverflow(page);
  // The pinned bar is compact (E5): one line + the button; the link box opens in a dialog from it.
  const pinned = nextStepCard(page);
  const open = pinned.getByRole("button", { name: /^send for checking$/i });
  await expect(open).toBeVisible();
  await expectInsideViewportX(page, open, "Send for checking");
  expect((await pinned.boundingBox())?.height ?? 999, "pinned next-step bar height").toBeLessThanOrEqual(100);
  await expect(pinned.getByRole("textbox")).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: /^send for checking$/i });
  await retrying(async () => {
    if (!(await dialog.isVisible())) await open.click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 3_000 });
  });
  const send = dialog.getByRole("button", { name: /^send for checking$/i });
  await expect(send).toBeDisabled();
  await dialog.getByRole("textbox", { name: /finished photos link/i }).fill(uniqUrl("finished"));
  await clickUntilCategory(page, send, api, job.id, "submitted");

  // Search opens the palette; Me opens My account.
  await retrying(async () => {
    if (!(await page.getByRole("dialog", { name: /command palette|search/i }).isVisible())) await tabBar(page).getByRole("button", { name: "Search" }).click({ timeout: 5_000 });
    await expect(page.getByRole("dialog", { name: /command palette|search/i })).toBeVisible({ timeout: 3_000 });
  });
  await expectInsideViewportX(page, page.getByRole("dialog", { name: /command palette|search/i }), "command palette");
  await page.keyboard.press("Escape");
  await retrying(async () => {
    await tabBar(page).getByRole("link", { name: "Me" }).click({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/settings\/account/, { timeout: 15_000 });
  });
  await session.dispose();
});

test("no horizontal scroll on the main screens at 390 and 768", async ({ page, api }) => {
  const job = await api.createJob({ name: uniq("E2E mobile overflow"), dueDate: civilDate(1) });
  const urls = ["/home", "/jobs", "/jobs?view=calendar", "/editors", "/clients", "/settings/studio", "/settings/people", "/settings/history", "/notifications", "/jobs/new", `/jobs/${job.id}`, "/help"];
  for (const url of urls) {
    await gotoReady(page, url, page.getByRole("main"));
    await expect(tabBar(page), url).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 768, height: 1024 });
  for (const url of urls) {
    await gotoReady(page, url, page.getByRole("main"));
    await expect(tabBar(page), `${url} @768`).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});
