import { civilDate, eventually, uniq } from "./api";
import { expect, gotoReady, retrying, test } from "./fixtures";
import type { Page } from "@playwright/test";

/** Filters, search and saved views (spec §40 "filters / search"; ARCHITECTURE §10). */

function workTable(page: Page) {
  return page.getByRole("table", { name: "All work" });
}

test("the Overdue quick filter keeps overdue jobs and drops on-time ones", async ({ page, api }) => {
  const base = uniq("Filter");
  const { projectId } = await api.createClientAndProject("Filter");
  const late = await api.createJob({ name: `${base} late`, projectId, dueDate: civilDate(-3) });
  const onTime = await api.createJob({ name: `${base} on time`, projectId, dueDate: civilDate(10) });
  expect((await api.job(late.id)).job.isOverdue).toBe(true);
  expect((await api.job(onTime.id)).job.isOverdue).toBe(false);

  await page.goto(`/workspace/all?q=${encodeURIComponent(base)}`);
  await expect(workTable(page).getByRole("link", { name: new RegExp(late.jobNumber) })).toBeVisible();
  await expect(workTable(page).getByRole("link", { name: new RegExp(onTime.jobNumber) })).toBeVisible();

  await page.getByRole("group", { name: "Quick filters" }).getByRole("button", { name: "Overdue", exact: true }).click();
  await expect(page).toHaveURL(/quick=overdue/);
  await expect(workTable(page).getByRole("link", { name: new RegExp(late.jobNumber) })).toBeVisible();
  await expect(workTable(page).getByRole("link", { name: new RegExp(onTime.jobNumber) })).toHaveCount(0);

  // Same answer from the API.
  const rows = await api.get<{ rows: { id: string }[] }>(`/api/jobs?q=${encodeURIComponent(base)}&quick=overdue`);
  expect(rows.rows.map((r) => r.id)).toEqual([late.id]);
});

test("searching an exact job number opens that job's History", async ({ page, api }) => {
  const job = await api.createJob({ name: uniq("Search target") });

  // Global search page: exact number → "Open full history".
  await page.goto(`/search?q=${job.jobNumber}`);
  await page.getByRole("link", { name: "Open full history" }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}\\?tab=history`));
  await expect(page.getByRole("tab", { name: "History", selected: true })).toBeVisible();

  // Command palette (Ctrl+K): typing the number offers "Open <number> history".
  await gotoReady(page, "/dashboard", page.getByRole("region", { name: "Key numbers" }));
  const palette = page.getByRole("dialog");
  // Before hydration the shortcut is not wired yet: press until the palette opens.
  await retrying(async () => {
    if (!(await palette.isVisible())) await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible({ timeout: 2_000 });
  }, 60_000);
  await page.keyboard.type(job.jobNumber, { delay: 20 });
  const historyItem = palette.getByRole("option", { name: new RegExp(`Open ${job.jobNumber} history`) });
  await expect(historyItem).toBeVisible();
  await historyItem.click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}\\?tab=history`));

  // API: exact match is flagged.
  const results = await api.get<{ exactJob: { id: string } | null }>(`/api/search?q=${job.jobNumber}`);
  expect(results.exactJob?.id).toBe(job.id);
});

test("save the current filters as a view and re-apply it", async ({ page, api }) => {
  const base = uniq("View");
  const job = await api.createJob({ name: `${base} job` });
  const viewName = uniq("E2E view");

  await page.goto(`/workspace/all?q=${encodeURIComponent(base)}`);
  await page.getByRole("button", { name: "Save view" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Save view" })).toBeVisible();
  await dialog.getByRole("textbox", { name: /Name/ }).fill(viewName);
  await dialog.getByRole("button", { name: "Save view" }).click();
  await expect(dialog).toBeHidden();

  const saved = await eventually(async () => {
    const views = await api.get<{ id: string; name: string; scope: string; version: number; config: { filters?: Record<string, unknown> } }[]>("/api/views?scope=all_work");
    return views.find((v) => v.name === viewName) ?? null;
  });
  expect(JSON.stringify(saved.config)).toContain(base);

  // Re-apply from a clean page.
  await page.goto("/workspace/all");
  const views = page.getByRole("group", { name: "Saved views" });
  await views.getByRole("button", { name: viewName }).click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(base).replace(/%20/g, "(%20|\\+)")));
  await expect(workTable(page).getByRole("link", { name: new RegExp(job.jobNumber) })).toBeVisible();
  await expect(views.getByRole("button", { name: viewName })).toHaveAttribute("aria-pressed", "true");

  // Tidy up (archive).
  await api.raw("DELETE", `/api/views/${saved.id}?expectedVersion=${saved.version}`);
});

test("keyboard: Ctrl+K, type an exact job number, Enter → that job's History", async ({ page, api }) => {
  const job = await api.createJob({ name: uniq("Search keyboard") });
  await gotoReady(page, "/dashboard", page.getByRole("region", { name: "Key numbers" }));
  const palette = page.getByRole("dialog");
  // Before hydration the shortcut is not wired yet: press until the palette opens.
  await retrying(async () => {
    if (!(await palette.isVisible())) await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible({ timeout: 2_000 });
  }, 60_000);
  await page.keyboard.type(job.jobNumber, { delay: 20 });
  const historyItem = palette.getByRole("option", { name: new RegExp(`Open ${job.jobNumber} history`) });
  await expect(historyItem).toBeVisible();
  // The exact match shows the ↵ hint, so it must be the highlighted item (not "See all results").
  await expect(historyItem).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}\\?tab=history`));
});
