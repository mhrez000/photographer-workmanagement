import type { Page } from "@playwright/test";
import { civilDate, uniq, type JobRow } from "./api";
import { UI_TEST_TIMEOUT, expect, expectInsideViewportX, expectNoHorizontalOverflow, gotoReady, jobHeading, retrying, test } from "./fixtures";

/**
 * Regressions (audit batch D, job detail + create form): every section tab is
 * reachable at 1440 and 390, the header shows exactly one overdue indicator,
 * the Links tab fits a 1024px viewport, and the /jobs/new URL input is wide
 * enough to read a URL.
 */
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

/** Tab label → `?tab=` key (Overview has none). Time shows because the org tracks time. */
const SECTIONS: { label: string; key: string | null }[] = [
  { label: "Overview", key: null },
  { label: "Links", key: "links" },
  { label: "Notes", key: "notes" },
  { label: "Comments", key: "comments" },
  { label: "Revisions", key: "revisions" },
  { label: "Timeline", key: "timeline" },
  { label: "Activity", key: "activity" },
  { label: "History", key: "history" },
  { label: "Time", key: "time" },
];

/** Opens a section from the visible tab strip, or from the "More sections" menu when it overflowed there. */
async function openSection(page: Page, label: string): Promise<void> {
  const tablist = page.getByRole("tablist", { name: "Job sections" });
  const tab = tablist.getByRole("tab", { name: label, exact: true });
  if ((await tab.count()) > 0) {
    await expect(tab).toBeVisible({ timeout: 2_000 });
    await expectInsideViewportX(page, tab, `${label} tab`);
    await tab.click();
    return;
  }
  const more = page.getByRole("button", { name: /^More sections:/ });
  await expect(more, `${label} is neither a tab nor behind "More"`).toHaveAccessibleName(new RegExp(`\\b${label}\\b`));
  await expectInsideViewportX(page, more, "More sections button");
  await more.click();
  const item = page.getByRole("menu", { name: "More job sections" }).getByRole("menuitem", { name: new RegExp(`^${label}\\b`) });
  await expect(item).toBeVisible({ timeout: 2_000 });
  await item.click();
}

async function expectEverySectionReachable(page: Page, job: Pick<JobRow, "id">): Promise<void> {
  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  for (const { label, key } of SECTIONS) {
    if (key === null) continue; // already on Overview; it is checked last
    await retrying(async () => {
      await openSection(page, label);
      await expect(page).toHaveURL(new RegExp(`[?&]tab=${key}(&|$)`), { timeout: 10_000 });
      await expect(page.getByRole("tabpanel")).toBeVisible({ timeout: 10_000 });
    });
    await expectNoHorizontalOverflow(page);
  }
  await retrying(async () => {
    await openSection(page, "Overview");
    await expect(page).not.toHaveURL(/[?&]tab=/, { timeout: 10_000 });
    await expect(page.getByRole("tabpanel", { name: "Overview" })).toBeVisible({ timeout: 10_000 });
  });
}

test.describe("at 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("every job section is reachable", async ({ page, api }) => {
    const job = await api.createJob({ name: uniq("Reg tabs 1440") });
    await expectEverySectionReachable(page, job);
  });

  test("an overdue job shows exactly one overdue indicator in its header", async ({ page, api }) => {
    // Names must not contain the word being counted.
    const editor = await api.inviteUser("editor", "Reg late");
    const job = await api.createJob({ name: uniq("Reg late header"), editorId: editor.user.id, dueDate: civilDate(-3) });
    await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
    // The header block = the sticky container around the job heading (stops before the tabs).
    const header = jobHeading(page).locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' border-b ')][1]");
    await expect(header).toContainText(/overdue/i);
    const text = await header.innerText();
    expect(text.match(/overdue/gi) ?? [], `header text: ${JSON.stringify(text)}`).toHaveLength(1);
  });

  test("the /jobs/new link URL input is at least 300px wide", async ({ page }) => {
    const url = page.getByRole("textbox", { name: "Link 1 URL" });
    await gotoReady(page, "/jobs/new", url);
    expect((await url.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(300);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("every job section is reachable", async ({ page, api }) => {
    const job = await api.createJob({ name: uniq("Reg tabs 390") });
    await expectEverySectionReachable(page, job);
  });
});

test.describe("at 1024px", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("the Links tab fits the viewport", async ({ page, api }) => {
    const job = await api.createJob({ name: uniq("Reg links 1024") });
    await api.addLink(
      job.id,
      "raw_files",
      "https://www.dropbox.com/scl/fo/abc123def456ghi789/AJk2x9_Qe7LmN0pRsTuVwXyZ?rlkey=q1w2e3r4t5y6u7i8o9p0&st=abcd1234&dl=0",
      "E2E raw files — Dropbox shoot folder with a fairly long label",
    );
    await api.addLink(job.id, "reference", "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit?usp=sharing");

    const panel = page.getByRole("tabpanel");
    await gotoReady(page, `/jobs/${job.id}?tab=links`, panel);
    await expect(panel).toContainText("E2E raw files");
    await expectNoHorizontalOverflow(page);
    await expectInsideViewportX(page, panel, "Links panel");
    const inner = await panel.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(inner.scroll, "the Links panel scrolls sideways").toBeLessThanOrEqual(inner.client + 1);
  });
});
