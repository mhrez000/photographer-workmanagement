import type { Page } from "@playwright/test";
import { ROLE_NAMES, civilDate, loginApi, type Api } from "./api";
import { FORBIDDEN_TEXT, UI_TEST_TIMEOUT, expect, expectPlainWords, gotoReady, retrying, sectionNamed, test } from "./fixtures";

/**
 * Tracking editors (docs/SIMPLIFICATION-PLAN.md §7): ONE page, Editors, for the owner. The
 * "Waiting on you" line, a period switch, one row per editor with five plain numbers (On their desk ·
 * Late now · Finished · On time · Needed changes), "Not enough jobs yet" below five finished jobs,
 * "Usually handles up to N" as "4 of 6", a CSV download, and the editor's own page.
 *
 * Every number is checked against jobs this spec creates for a fresh editor.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const FIVE = ["On their desk", "Late now", "Finished", "On time", "Needed changes"] as const;

/** The editor's row of the table (laptops); the phone cards are hidden at 1440 and skipped by role queries. */
function editorRow(page: Page, name: string) {
  return page.getByRole("main").getByRole("row").filter({ hasText: name }).first();
}

/** A fresh editor with 2 on their desk (1 late), 1 finished (sent on time, no changes). */
async function editorWithNumbers(api: Api, label: string) {
  const editor = await api.inviteUser("editor", label);
  await api.setUsualCapacity(editor.user.id, 5); // "Usually handles up to 5" → "2 of 5"
  const session = await loginApi(editor.email, editor.tempPassword);
  const stamp = Date.now().toString(36);
  const onDesk = await api.createJob({ name: `E2E ${stamp} on desk`, editorId: editor.user.id, dueDate: civilDate(3) });
  const late = await api.createJob({ name: `E2E ${stamp} late now`, editorId: editor.user.id, dueDate: civilDate(-1) });
  const finished = await api.createJob({ name: `E2E ${stamp} finished`, editorId: editor.user.id, dueDate: civilDate(2) });
  await session.sendForChecking(finished.id);
  await api.approve(finished.id, "n/a");
  await session.dispose();
  return { editor, onDesk, late, finished };
}

test("Editors: Waiting on you, period switch, one row per editor with the five numbers, Not enough jobs yet, CSV", async ({ page, api }) => {
  const { editor, finished } = await editorWithNumbers(api, "Numbers");

  await gotoReady(page, "/editors", page.getByRole("main").getByText(/waiting on you/i));
  await expectPlainWords(page, "/editors");
  const main = page.getByRole("main");

  // Top line: the owner's own waiting pile, never counted against an editor.
  await expect(main.getByText(/Waiting on you:/i)).toBeVisible();
  // Period: This month · Last month · Last 3 months.
  const period = main.getByRole("radiogroup", { name: /period/i });
  for (const label of ["This month", "Last month", "Last 3 months"]) await expect(period.getByRole("radio", { name: label }), label).toBeVisible();
  // The five column headings, and none of the dropped words.
  for (const h of FIVE) await expect(main.getByRole("columnheader", { name: h }), h).toBeVisible();
  await expect(main.getByText(/capacity|utilisation|turnaround|band/i)).toHaveCount(0);

  // The seeded editors are there.
  await expect(editorRow(page, ROLE_NAMES.editor!)).toBeVisible();
  await expect(editorRow(page, ROLE_NAMES.editor2!)).toBeVisible();
  await expect(editorRow(page, ROLE_NAMES.editor3!)).toBeVisible();

  // Our editor: 2 on their desk, 1 late now (red), 1 finished, percentages "Not enough jobs yet".
  const row = editorRow(page, editor.user.name);
  await expect(row).toBeVisible();
  const cells = (await row.getByRole("cell").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(cells[1], "On their desk · Usually handles up to 5").toBe("2 of 5");
  expect(cells[2], "Late now").toBe("1");
  expect(cells[3], "Finished").toBe("1");
  expect(cells[4], "On time").toBe("Not enough jobs yet");
  expect(cells[5], "Needed changes").toBe("Not enough jobs yet");

  // Rows are sorted with "Late now" first: our editor (1 late) sits above a quiet editor.
  const quiet = await api.inviteUser("editor", "Quiet");
  await page.reload();
  const names = (await main.getByRole("row").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
  const idx = (n: string) => names.findIndex((t) => t.includes(n));
  expect(idx(editor.user.name)).toBeGreaterThanOrEqual(0);
  expect(idx(quiet.user.name)).toBeGreaterThan(idx(editor.user.name));

  // Each number explains itself on hover / tap (the heading is a button with a tooltip).
  const heading = main.getByRole("columnheader", { name: "On time" }).getByRole("button");
  await heading.hover();
  await expect(main.getByRole("tooltip").filter({ hasText: /first sent for checking/i })).toBeVisible();

  // Download CSV: a real text/csv file naming the editor and the extra "average days to edit" column.
  const csvLink = main.getByRole("link", { name: /download csv/i });
  await expect(csvLink).toBeVisible();
  const href = await csvLink.getAttribute("href");
  expect(href).toMatch(/\/api\/editors\.csv/);
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  const body = await res.text();
  expect(body).toContain(editor.user.name);
  expect(body.toLowerCase()).toMatch(/average days to edit|days to edit/);
  expect(finished.id).toBeTruthy();
});

test("the editor's page: five numbers with vs-last-month arrows, On their desk now, Recently finished, Give them a job", async ({ page, api }) => {
  const { editor, onDesk, late, finished } = await editorWithNumbers(api, "Detail");

  await gotoReady(page, "/editors", editorRow(page, editor.user.name));
  const editorUrl = new RegExp(`/editors/${editor.user.id}`);
  await retrying(async () => {
    // A slow first compile can land after the 15 s check: click again only while still on the list.
    if (!editorUrl.test(page.url())) await editorRow(page, editor.user.name).getByRole("link").first().click({ timeout: 5_000 });
    await expect(page).toHaveURL(editorUrl, { timeout: 15_000 });
  });
  await expectPlainWords(page, `/editors/${editor.user.id}`);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toContainText(editor.user.name);
  await expect(main.getByText(/Usually handles up to 5/i)).toBeVisible();
  for (const h of FIVE) await expect(main.getByText(h, { exact: true }).first(), h).toBeVisible();
  await expect(main.getByText(/vs last month/i).first()).toBeVisible();
  // The two snapshot numbers say "Right now" where the others carry the vs-last-month arrow: no tile looks unfinished.
  await expect(main.getByText("Right now", { exact: true })).toHaveCount(2);

  // On their desk now: both held jobs with stage and due date, a Change editor action per job.
  const desk = sectionNamed(page, /^on their desk now/i);
  await expect(desk).toContainText(onDesk.name);
  await expect(desk).toContainText(late.name);
  await expect(desk).toContainText(/1 day late/i);
  await expect(desk.getByRole("button", { name: /change editor/i }).first()).toBeVisible();
  await expect(desk.locator("span[data-stage]").first()).toBeVisible();

  // Recently finished: On time, no changes asked.
  const recent = sectionNamed(page, /^recently finished/i);
  await expect(recent).toContainText(finished.name);
  await expect(recent).toContainText(/on time/i);
  await expect(recent).toContainText(/No changes asked/i);
  // Actions.
  await expect(main.getByRole("link", { name: /give them a job/i })).toHaveAttribute("href", new RegExp(`/jobs/new\\?editorId=${editor.user.id}`));
  await expect(main.getByRole("button", { name: /move their jobs to/i })).toBeVisible();
  await expect(main.getByRole("link", { name: /edit person/i })).toBeVisible();
  // A "finished per week" chart.
  await expect(main.getByText(/finished per week/i).first()).toBeVisible();
});

test("Home → Your editors matches the Editors page row for the same editor", async ({ page, api }) => {
  const { editor } = await editorWithNumbers(api, "Home row");
  await gotoReady(page, "/home", sectionNamed(page, /^your editors/i));
  const block = sectionNamed(page, /^your editors/i);
  const row = block.getByRole("listitem").filter({ hasText: editor.user.name }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(/On their desk\s*2/i);
  await expect(row).toContainText(/Late\s*1/i);
  await expect(row).toContainText(/Not enough jobs yet/i);
  await retrying(async () => {
    await row.getByRole("link").first().click({ timeout: 5_000 });
    await expect(page).toHaveURL(new RegExp(`/editors/${editor.user.id}`), { timeout: 15_000 });
  });
});

test.describe("who may open Editors", () => {
  test("the extra photographer and editors are refused; the old Team addresses redirect there", async ({ pageAs, apiAs }) => {
    for (const role of ["photographer", "editor"] as const) {
      const p = await pageAs(role);
      const res = await p.goto("/editors");
      expect([403, 404], `${role} → /editors`).toContain(res?.status());
      if (res?.status() === 403) await expect(p.getByText(FORBIDDEN_TEXT)).toBeVisible();
    }
    const owner = await apiAs("owner");
    for (const path of ["/team/editors", "/team/workloads", "/team/performance"]) {
      const { status, location } = await owner.pageStatus(path);
      expect(status, path).toBe(307);
      expect(location, path).toMatch(/\/editors$/);
    }
  });
});
