import type { Page } from "@playwright/test";
import { ROLE_EMAILS, civilDate, loginApi, uniq, type Api } from "./api";
import { UI_TEST_TIMEOUT, expect, expectPlainWords, gotoReady, retrying, test } from "./fixtures";

/**
 * The one Jobs page (docs/SIMPLIFICATION-PLAN.md §1, §3, §4, §8 "Kept, and polished"): stage tabs
 * with counts (All active · Needs editor · With editor · Ready to check · Changes asked · Done),
 * the Late filter and Show cancelled, a List / Calendar switch, and search. There is no
 * "mine / team / all" split: the owner sees the whole business, filtered only by what they type.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const STAGE_TABS = ["All active", "Needs editor", "With editor", "Ready to check", "Changes asked", "Done"] as const;

/** The stage tabs are plain links in `<nav aria-label="Stages">` (shareable URLs, no JS). */
function tabs(page: Page) {
  return page.getByRole("main").getByRole("navigation", { name: "Stages" });
}

function tab(page: Page, label: string) {
  return tabs(page).getByRole("link", { name: new RegExp(`^${label}\\b`) });
}

/** Count badge inside a stage tab: "Needs editor 1" → 1. */
async function tabCount(page: Page, label: string): Promise<number> {
  const text = (await tab(page, label).innerText()).replace(/\s+/g, " ");
  const m = text.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

/** Visible job-name links of the list (the table on laptops; the phone cards are hidden there). */
function rows(page: Page) {
  return page.getByRole("main").getByRole("link", { name: /E2E JP/ });
}

/** One job in every stage, plus a late one and a cancelled one, all carrying the search term. */
async function seedStages(api: Api, term: string) {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const ed = await loginApi(ROLE_EMAILS.editor);
  const { clientId } = await api.createClient("Jobs page");
  const make = (suffix: string, extra: Record<string, unknown> = {}) => api.createJob({ name: `${term} ${suffix}`, clientId, dueDate: civilDate(3), ...extra });

  const needsEditor = await make("needs editor");
  const withEditor = await make("with editor", { editorId: editor.id });
  const readyToCheck = await make("ready to check", { editorId: editor.id });
  await ed.sendForChecking(readyToCheck.id);
  const changesAsked = await make("changes asked", { editorId: editor.id });
  await ed.sendForChecking(changesAsked.id);
  await api.askForChanges(changesAsked.id, "Warmer kitchen", ["Colour"]);
  const done = await make("done", { editorId: editor.id });
  await ed.sendForChecking(done.id);
  await api.approve(done.id, "n/a");
  const late = await make("late with editor", { editorId: editor.id, dueDate: civilDate(-2) });
  const cancelled = await make("cancelled");
  await api.action(cancelled.id, "cancel", { reason: "E2E: drone permit refused" });
  await ed.dispose();
  return { needsEditor, withEditor, readyToCheck, changesAsked, done, late, cancelled };
}

test("stage tabs with counts, Late filter, Show cancelled, search — the owner sees the whole business", async ({ page, api }) => {
  const term = uniq("E2E JP");
  const jobs = await seedStages(api, term);
  const url = `/jobs?q=${encodeURIComponent(term)}`;

  await gotoReady(page, url, tabs(page));
  await expectPlainWords(page, "/jobs");
  // No scope switch anywhere (plan §3).
  await expect(page.getByRole("banner").getByText(/whole business|my shoots/i)).toHaveCount(0);
  await expect(page.getByRole("main").getByText(/whole business|my shoots|team work|all work/i)).toHaveCount(0);

  // Six tabs, in order, with counts for this search; Cancelled is not a tab.
  const labels = (await tabs(page).getByRole("link").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels.map((l) => l.replace(/\s*\d+$/, ""))).toEqual([...STAGE_TABS]);
  expect(labels.some((l) => /cancelled/i.test(l))).toBe(false);
  await expect.poll(() => tabCount(page, "All active")).toBe(5); // Done and Cancelled never count as active
  expect(await tabCount(page, "Needs editor")).toBe(1);
  expect(await tabCount(page, "With editor")).toBe(2); // incl. the late one
  expect(await tabCount(page, "Ready to check")).toBe(1);
  expect(await tabCount(page, "Changes asked")).toBe(1);
  expect(await tabCount(page, "Done")).toBe(1);

  // All active lists the five active jobs; Done and Cancelled are absent.
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByRole("main").getByText(jobs.done.name)).toHaveCount(0);
  await expect(page.getByRole("main").getByText(jobs.cancelled.name)).toHaveCount(0);
  // The JOB column (the address) keeps at least a quarter of the table and the table never scrolls sideways (UX-01);
  // Round N appears once per row, as the badge, never also inside the stage pill (UX-10).
  const table = page.getByRole("main").locator("table[data-jobs-table]");
  await expect(table).toBeVisible();
  const layout = await table.evaluate((t) => {
    const wrap = t.parentElement as HTMLElement;
    const job = t.querySelector("th") as HTMLElement;
    return { jobShare: job.getBoundingClientRect().width / t.getBoundingClientRect().width, overflow: wrap.scrollWidth - wrap.clientWidth, dupes: [...t.querySelectorAll("tbody tr")].filter((tr) => ((tr as HTMLElement).innerText.match(/Round \d/g) ?? []).length > 1).length };
  });
  expect(layout.jobShare).toBeGreaterThan(0.25);
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.dupes).toBe(0);
  // Every row says who it is waiting on; the late one wears a red "late" chip.
  await expect(page.getByRole("main").getByRole("columnheader", { name: /waiting on/i })).toBeVisible();
  const lateRow = page.getByRole("main").getByRole("row").filter({ hasText: jobs.late.name }).first();
  await expect(lateRow).toContainText(/\d+ days? late/i);
  await expect(lateRow.locator("span[data-stage]")).toHaveAttribute("data-stage", "with_editor");

  // A stage tab filters the list and the URL.
  await retrying(async () => {
    await tab(page, "Ready to check").click({ timeout: 5_000 });
    await expect(page).toHaveURL(/stage=ready_to_check/, { timeout: 10_000 });
  });
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("main").getByText(jobs.readyToCheck.name).locator("visible=true")).toBeVisible();
  await expect(tab(page, "Ready to check")).toHaveAttribute("aria-current", "page");

  await retrying(async () => {
    await tab(page, "Done").click({ timeout: 5_000 });
    await expect(page).toHaveURL(/stage=done/, { timeout: 10_000 });
  });
  await expect(page.getByRole("main").getByText(jobs.done.name).locator("visible=true")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);

  // Late is a filter (a switch), not a stage: it keeps only the late job across every active stage.
  await gotoReady(page, url, tabs(page));
  const lateFilter = page.getByRole("main").getByRole("switch", { name: /^late/i });
  await expect(lateFilter).toHaveAccessibleName(/Late · 1/);
  await retrying(async () => {
    await lateFilter.click({ timeout: 5_000 });
    await expect(page).toHaveURL(/late=1/, { timeout: 10_000 });
  });
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("main").getByText(jobs.late.name).locator("visible=true")).toBeVisible();

  // Show cancelled adds the cancelled job to All active.
  await gotoReady(page, url, tabs(page));
  const showCancelled = page.getByRole("main").getByRole("switch", { name: /show cancelled/i });
  await expect(showCancelled).toHaveAccessibleName(/Show cancelled · 1/);
  await retrying(async () => {
    await showCancelled.click({ timeout: 5_000 });
    await expect(page).toHaveURL(/cancelled=1/, { timeout: 10_000 });
  });
  await expect(page.getByRole("main").getByText(jobs.cancelled.name).locator("visible=true")).toBeVisible();
  await expect(rows(page)).toHaveCount(6);
  const cancelledRow = page.getByRole("main").getByRole("row").filter({ hasText: jobs.cancelled.name }).first();
  await expect(cancelledRow.locator("span[data-stage]")).toHaveAttribute("data-stage", "cancelled");

  // The same answer from the API: the one list and its tab counts come from the same query (plan §1).
  const list = await api.get<{ rows: { id: string }[]; total: number; counts: { allActive: number; byStage: Record<string, number>; late: number; cancelled: number } }>(
    `/api/jobs/simple?q=${encodeURIComponent(term)}&limit=100`,
  );
  expect(list.counts).toMatchObject({ allActive: 5, late: 1, cancelled: 1, byStage: { needs_editor: 1, with_editor: 2, ready_to_check: 1, changes_asked: 1, done: 1 } });
  expect(list.rows.map((r) => r.id).sort()).toEqual([jobs.needsEditor.id, jobs.withEditor.id, jobs.readyToCheck.id, jobs.changesAsked.id, jobs.late.id].sort());
});

test("search narrows the list by address, client and job number; nothing else is required", async ({ page, api }) => {
  const term = uniq("E2E JP search");
  const { clientId, clientName } = await api.createClient("Jobs search");
  const a = await api.createJob({ name: `${term} alpha`, clientId, dueDate: civilDate(2) });
  const b = await api.createJob({ name: `${term} bravo`, clientId, dueDate: civilDate(2) });

  await gotoReady(page, "/jobs", tabs(page));
  const search = page.getByRole("main").getByRole("searchbox", { name: /search jobs/i }).or(page.getByRole("main").getByRole("textbox", { name: /search jobs/i })).first();
  await search.fill(`${term} alpha`);
  await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(term).replace(/%20/g, "(%20|\\+)")}`), { timeout: 15_000 });
  await expect(page.getByRole("main").getByText(a.name).locator("visible=true")).toBeVisible();
  await expect(page.getByRole("main").getByText(b.name)).toHaveCount(0);

  // By job number.
  await gotoReady(page, `/jobs?q=${encodeURIComponent(b.jobNumber)}`, tabs(page));
  await expect(page.getByRole("main").getByText(b.name).locator("visible=true")).toBeVisible();
  await expect(page.getByRole("main").getByText(a.name)).toHaveCount(0);

  // By client (the Client filter).
  await gotoReady(page, `/jobs?clientId=${clientId}`, tabs(page));
  await expect(page.getByRole("main").getByText(a.name).locator("visible=true")).toBeVisible();
  await expect(page.getByRole("main").getByText(b.name).locator("visible=true")).toBeVisible();
  await expect(page.getByRole("main").getByRole("combobox", { name: "Client" })).toHaveValue(clientId);
  // The filters are plain: Editor / Client selects, nothing to save or group by.
  await expect(page.getByRole("main").getByRole("combobox", { name: "Editor" })).toBeVisible();
  await expect(page.getByRole("main").getByText(/saved views|group by|columns|bulk/i)).toHaveCount(0);
  await expect(page.getByRole("main")).toContainText(clientName);

  // Ctrl+K still works (plan §3) and finds the job.
  const palette = page.getByRole("dialog", { name: /command palette|^search$/i });
  await retrying(async () => {
    if (!(await palette.isVisible())) await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible({ timeout: 2_000 });
  }, 60_000);
  await page.keyboard.type(a.jobNumber, { delay: 20 });
  await expect(palette.getByRole("option", { name: new RegExp(a.jobNumber) }).first()).toBeVisible();
});

test("List / Calendar switch: the calendar shows the shoot and due dates of the same jobs", async ({ page, api }) => {
  const term = uniq("E2E JP cal");
  const job = await api.createJob({ name: `${term} shoot`, shootDate: civilDate(0), dueDate: civilDate(1) });

  await gotoReady(page, `/jobs?q=${encodeURIComponent(term)}`, tabs(page));
  const view = page.getByRole("main").getByRole("radiogroup", { name: /list or calendar/i });
  await expect(view).toBeVisible();
  await retrying(async () => {
    await view.getByRole("radio", { name: /^calendar$/i }).click({ timeout: 5_000 });
    await expect(page).toHaveURL(/view=calendar/, { timeout: 10_000 });
  });
  // The job appears on the calendar (shoot today, due tomorrow); the stage tabs step aside.
  await expect(page.getByRole("main").getByText(job.name).first()).toBeVisible();
  await expect(tabs(page)).toHaveCount(0);
  await expectPlainWords(page, "/jobs calendar");

  await retrying(async () => {
    await view.getByRole("radio", { name: /^list$/i }).click({ timeout: 5_000 });
    await expect(page).not.toHaveURL(/view=calendar/, { timeout: 10_000 });
  });
  await expect(tabs(page)).toBeVisible();
});

test.describe("extra photographer", () => {
  test.use({ role: "photographer" });

  test("sees only their own shoots on Jobs; the owner's shoot is not listed and is a 404", async ({ page, api, apiAs }) => {
    const p01 = await apiAs("photographer");
    const me = await p01.me();
    expect(me.user.persona).toBe("member");
    expect(me.user.canViewAllJobs).toBe(false);
    const term = uniq("E2E JP own");
    const own = await api.createJob({ name: `${term} mine`, photographerId: me.user.id, dueDate: civilDate(2) });
    const theirs = await api.createJob({ name: `${term} owner`, dueDate: civilDate(2) });

    await gotoReady(page, `/jobs?q=${encodeURIComponent(term)}`, tabs(page));
    await expect(page.getByRole("main").getByText(own.name).locator("visible=true")).toBeVisible();
    await expect(page.getByRole("main").getByText(theirs.name)).toHaveCount(0);
    expect((await p01.raw("GET", `/api/jobs/${theirs.id}`)).status).toBe(404);
    const res = await page.goto(`/jobs/${theirs.id}`);
    expect(res?.status()).toBe(404);
  });
});
