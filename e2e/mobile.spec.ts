import type { Page } from "@playwright/test";
import { civilDate, uniq } from "./api";
import { UI_TEST_TIMEOUT, expect, expectInsideViewportX, expectNoHorizontalOverflow, gotoReady, jobHeading, myWorkCard, retrying, storageFor, test } from "./fixtures";

/**
 * Mobile (spec §28, §40 "mobile viewport"; runs in the `mobile` project at
 * 390×844 with touch): the dashboard, My Work and a job's detail page are
 * usable, nothing scrolls sideways, and navigation is the bottom tab bar.
 */
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const tabBar = (page: Page) => page.getByRole("navigation", { name: "Primary" });

test("dashboard: KPIs and the bottom tab bar, no sidebar, no horizontal scroll", async ({ page }) => {
  expect(page.viewportSize()?.width).toBe(390);
  await gotoReady(page, "/dashboard", page.getByRole("region", { name: "Key numbers" }));
  await expectNoHorizontalOverflow(page);

  const bar = tabBar(page);
  await expect(bar).toBeVisible();
  for (const label of ["Home", "My Work", "Kanban", "Search", "More"]) {
    const item = bar.getByRole("link", { name: label }).or(bar.getByRole("button", { name: label }));
    await expect(item, `tab ${label}`).toBeVisible();
    await expectInsideViewportX(page, item, `${label} tab`);
  }
  await expect(bar.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  // The bar sits at the bottom of the screen; the desktop sidebar is not shown.
  const box = await bar.boundingBox();
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBeGreaterThanOrEqual(844 - 1);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();

  // Tabs navigate; "More" opens the full navigation drawer; "Search" opens the palette.
  await retrying(async () => {
    await bar.getByRole("link", { name: "My Work" }).click({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/workspace\/my/, { timeout: 15_000 });
  });
  await expect(bar.getByRole("link", { name: "My Work" })).toHaveAttribute("aria-current", "page");

  await retrying(async () => {
    if (!(await page.getByRole("dialog", { name: "Navigation" }).isVisible())) await bar.getByRole("button", { name: "More" }).click({ timeout: 5_000 });
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible({ timeout: 3_000 });
  });
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer.getByRole("link", { name: "All Work" })).toBeVisible();
  // Let the slide-in finish, then measure.
  await expect.poll(async () => Math.round((await drawer.boundingBox())?.x ?? -999)).toBeGreaterThanOrEqual(0);
  await expectInsideViewportX(page, drawer, "navigation drawer");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  await retrying(async () => {
    if (!(await page.getByRole("dialog", { name: "Command palette" }).isVisible())) await bar.getByRole("button", { name: "Search" }).click({ timeout: 5_000 });
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible({ timeout: 3_000 });
  });
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect.poll(async () => Math.round((await palette.boundingBox())?.x ?? -999)).toBeGreaterThanOrEqual(0);
  await expectInsideViewportX(page, palette, "command palette");
});

test("my work + job detail: an editor can start a job from the phone", async ({ api, pageWithState }) => {
  const editor = await api.inviteUser("editor", "Mobile");
  const name = uniq("Mobile job");
  const job = await api.createJob({ name, editorId: editor.user.id, dueDate: civilDate(2) });
  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));

  // My Work lists the job as a card that fits the screen, with its next step on the card.
  await gotoReady(page, "/workspace/my", myWorkCard(page, name));
  const card = myWorkCard(page, name);
  await expectInsideViewportX(page, card, "My Work card");
  await expect(card.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(tabBar(page)).toBeVisible();

  // Open it: the job detail page is readable and its primary action is reachable.
  await retrying(async () => {
    await card.getByRole("link", { name }).click({ timeout: 5_000 });
    await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}`), { timeout: 15_000 });
  });
  await expect(jobHeading(page)).toContainText(name);
  await expectNoHorizontalOverflow(page);

  const start = page.getByRole("button", { name: "Start", exact: true }).first();
  await expect(start).toBeVisible();
  await expectInsideViewportX(page, start, "Start button");
  await retrying(async () => {
    if ((await api.job(job.id)).job.statusCategory !== "in_progress") await start.click({ timeout: 5_000 });
    expect((await api.job(job.id)).job.statusCategory).toBe("in_progress");
  }, 60_000);
  await page.reload();
  const submit = page.getByRole("button", { name: "Submit for review" }).first();
  await expect(submit).toBeVisible();
  await expectInsideViewportX(page, submit, "Submit for review button");
  await expectNoHorizontalOverflow(page);
});

test("no horizontal scroll on the main screens", async ({ page, api }) => {
  const job = await api.createJob({ name: uniq("Mobile overflow"), dueDate: civilDate(1) });
  const urls = ["/dashboard", "/workspace/my", "/workspace/all", "/workspace/kanban", "/workspace/calendar", "/workspace/timeline", "/notifications", "/activity", "/jobs/new", `/jobs/${job.id}`, `/jobs/${job.id}?tab=history`];
  for (const url of urls) {
    await gotoReady(page, url, page.getByRole("main"));
    await expect(tabBar(page), url).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  // Tablet (spec §28: 768 px) keeps the tab bar and never scrolls sideways either.
  await page.setViewportSize({ width: 768, height: 1024 });
  for (const url of urls) {
    await gotoReady(page, url, page.getByRole("main"));
    await expect(tabBar(page), `${url} @768`).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});
