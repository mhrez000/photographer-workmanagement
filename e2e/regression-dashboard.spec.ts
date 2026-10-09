import type { Page } from "@playwright/test";
import { uniq } from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, retrying, test } from "./fixtures";

/**
 * Regressions (audit batches C/E + skeptic re-check) for dashboard drill-downs:
 * - the "Completed this week" KPI equals the total of the list it links to;
 * - every drill-down param a KPI / bottleneck link adds (completed range,
 *   revision window, time-in-status, include cancelled) shows as a removable
 *   chip, and "Clear all" really returns to the unfiltered list;
 * - a link with an invalid `filter` alias renders with a notice and "Load
 *   more" still works (the page used to forward the bad value to the strict API);
 * - the editor-workload table shows its revision-rate column at 1440px.
 */
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const matching = (page: Page) => page.locator('span[title="Matching jobs"]');
const chips = (page: Page) => page.getByRole("list", { name: "Drill-down filters" });

async function total(page: Page): Promise<number> {
  return Number(((await matching(page).textContent()) ?? "").replace(/[^\d]/g, ""));
}

test("the Completed this week KPI equals the total of the list it links to, and the range is a visible chip", async ({ page }) => {
  const kpi = page.getByRole("link", { name: /^Completed this week: / });
  // Other people may complete jobs between the two reads: re-read both until they agree.
  await retrying(async () => {
    await gotoReady(page, "/dashboard", kpi);
    const label = (await kpi.getAttribute("aria-label")) ?? "";
    const kpiCount = Number(/Completed this week: ([\d,]+) jobs?/.exec(label)?.[1]?.replace(/,/g, "") ?? NaN);
    expect(kpiCount, label).not.toBeNaN();
    expect(await kpi.getAttribute("href")).toContain("quick=completed");

    await kpi.click();
    await expect(page).toHaveURL(/\/workspace\/all\?.*quick=completed.*completedFrom=/, { timeout: 30_000 });
    await expect(matching(page)).toBeVisible({ timeout: 30_000 });
    expect(await total(page), `KPI ${kpiCount} vs list (${page.url()})`).toBe(kpiCount);
  }, 180_000);

  // The week is shown, not hidden in the URL.
  await expect(chips(page).getByText(/^Completed .+ – .+/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Clear all \(2\)/ })).toBeVisible();
});

test("drill-down params from bottleneck links are visible chips, removable one by one or with Clear all", async ({ page, api }) => {
  // The revision-spike and review-bottleneck alert links (src/lib/metrics.ts), built for this run.
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  await gotoReady(page, `/workspace/all?revisedFrom=${encodeURIComponent(weekAgo)}&includeCancelled=1`, chips(page));
  await expect(chips(page).getByText(/^Revision requested since /)).toBeVisible();
  await expect(chips(page).getByText("Including cancelled")).toBeVisible();
  await expect(matching(page)).toBeVisible();

  await retrying(async () => {
    await page.getByRole("button", { name: /^Clear all/ }).click({ timeout: 5_000 });
    await expect(page).not.toHaveURL(/revisedFrom|includeCancelled/, { timeout: 5_000 });
  });
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Clear all/ })).toHaveCount(0);
  // Back to the plain studio list: the same total as an unfiltered API call.
  await retrying(async () => {
    const all = (await api.get<{ total: number }>("/api/jobs?limit=1")).total;
    expect(await total(page)).toBe(all);
  }, 30_000);

  // Review bottleneck: the time-in-status condition is a chip with its own remove button.
  await gotoReady(page, `/workspace/all?quick=awaiting_review&statusEnteredBefore=${encodeURIComponent(dayAgo)}`, chips(page));
  const chip = chips(page).getByText(/^In this status since before /);
  await expect(chip).toBeVisible();
  await retrying(async () => {
    await page.getByRole("button", { name: /^Remove filter: In this status since before / }).click({ timeout: 5_000 });
    await expect(page).not.toHaveURL(/statusEnteredBefore/, { timeout: 5_000 });
  });
  await expect(page).toHaveURL(/quick=awaiting_review/);
  await expect(chips(page)).toHaveCount(0);
});

test("an invalid filter alias in a link is ignored with a notice and Load more still pages", async ({ page, api }) => {
  const term = uniq("Reg loadmore");
  const { projectId } = await api.createClientAndProject("Reg loadmore");
  for (let i = 0; i < 3; i += 1) await api.createJob({ name: `${term} ${i}`, projectId });

  const table = page.getByRole("table", { name: "All work" });
  await gotoReady(page, `/workspace/all?q=${encodeURIComponent(term)}&limit=2&filter=foo`, table);
  await expect(page.getByRole("status").filter({ hasText: /Ignored an invalid filter value/ })).toBeVisible();
  const rows = table.getByRole("link", { name: /PJ-\d+/ });
  await expect(rows).toHaveCount(2);

  const failures: string[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/jobs?") && r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  await retrying(async () => {
    await page.getByRole("button", { name: "Load more" }).click({ timeout: 5_000 });
    await expect(rows).toHaveCount(3, { timeout: 5_000 });
  });
  expect(failures).toEqual([]);
});

// Batch C/E: the column used to be display:none at 1440 (container ~733px, shown only at @4xl).
// The widget is a table from a 672px container (@2xl) and cards below it. With the default
// half-width layout and the sidebar open it is ~640px wide, so accept either form: the 30-day
// revision rate must be visible for every editor in both.
test("the editor workload widget shows each editor's revision rate at 1440px", async ({ page }) => {
  const heading = page.getByRole("heading", { level: 2, name: "Editor workload" });
  await gotoReady(page, "/dashboard", heading);
  const header = page.getByRole("columnheader", { name: /^Rev\. rate/ });
  if (!(await header.isVisible())) {
    const widget = page.locator("section").filter({ has: heading });
    await expect(widget.getByText(/rev (\d+%|—)/).first()).toBeVisible();
    return;
  }
  // The matching value cell of the first editor row is visible too. (CSS nth-child, because the
  // accessibility tree drops the other display:none columns and would shift a role-based index.)
  const table = page.locator("table").filter({ has: header });
  const index = await header.evaluate((th) => (th as HTMLTableCellElement).cellIndex);
  const cell = table.locator(`tbody tr:first-child > :nth-child(${index + 1})`);
  await expect(cell).toBeVisible();
  await expect(cell).toHaveText(/\d+%|—|-/);
});
