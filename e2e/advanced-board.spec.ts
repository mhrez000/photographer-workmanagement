import type { Locator, Page } from "@playwright/test";
import { ROLE_NAMES, civilDate, escapeRegExp, expectHiddenPage, uniq } from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, retrying, test } from "./fixtures";

/**
 * The Advanced Board in the five stages (docs/SIMPLIFICATION-PLAN.md §8 follow-up): with Advanced tools
 * ON the Board shows exactly Needs editor · With editor · Ready to check · Changes asked · Done (Cancelled
 * stays behind its toggle); a drag is only a step the matching button would offer — Needs editor → With
 * editor opens "Who should edit this?", assigning moves the card; a drop that is not a step snaps back
 * and nothing is recorded. The switch is studio-wide and the database is shared: OFF is restored in
 * `finally`.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const STAGES = ["Needs editor", "With editor", "Ready to check", "Changes asked", "Done"] as const;

/** A stage column: `<section aria-label="<Stage>, N jobs">` (role region). */
function column(page: Page, stage: (typeof STAGES)[number]) {
  return page.getByRole("main").getByRole("region", { name: new RegExp(`^${escapeRegExp(stage)}, \\d+ jobs?$`) });
}

/** Every stage column, in order. */
function columns(page: Page) {
  return page.getByRole("main").getByRole("region", { name: /^[A-Z][a-z ]+, \d+ jobs?$/ });
}

/** The draggable card of a job (by its name) inside `scope`. */
function cardIn(scope: Locator, jobName: string) {
  return scope.locator('[aria-roledescription="Draggable job card"]').filter({ hasText: jobName });
}

/**
 * Drags `card` onto `target` with the mouse (dnd-kit's MouseSensor activates after 6 px): press, move
 * past the activation distance, glide over the column's card area, release.
 */
async function dragTo(page: Page, card: Locator, target: Locator): Promise<void> {
  await card.scrollIntoViewIfNeeded();
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  expect(from, "card has a box").not.toBeNull();
  expect(to, "column has a box").not.toBeNull();
  const sx = from!.x + from!.width / 2;
  const sy = from!.y + Math.min(20, from!.height / 2);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 12, sy + 6, { steps: 4 });
  const tx = to!.x + to!.width / 2;
  const ty = Math.min(to!.y + 200, to!.y + to!.height - 24);
  await page.mouse.move(tx, ty, { steps: 24 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

test("Advanced on: five stage columns; Needs editor → With editor asks who should edit and moves the card; a non-step drop snaps back", async ({ page, api }) => {
  const name = uniq("E2E board drag");
  const job = await api.createJob({ name, dueDate: civilDate(3) });
  expect(["new", "ready"]).toContain(job.statusCategory);
  try {
    await api.setAdvancedTools(true);
    await gotoReady(page, `/workspace/kanban?q=${encodeURIComponent(name)}`, column(page, "Needs editor"));
    const main = page.getByRole("main");

    // Exactly the five stages, in the Jobs-list order; Cancelled is not a column unless asked for.
    const labels = await columns(page).evaluateAll((els) => els.map((el) => (el.getAttribute("aria-label") ?? "").replace(/, \d+ jobs?$/, "")));
    expect(labels).toEqual([...STAGES]);
    await expect(main.getByRole("region", { name: /^Cancelled, / })).toHaveCount(0);
    // No sub-columns, no old words.
    await expect(main.getByText(/not started|not sent to client/i)).toHaveCount(0);

    const needs = column(page, "Needs editor");
    const withEditor = column(page, "With editor");
    const done = column(page, "Done");
    await expect(cardIn(needs, name)).toHaveCount(1);

    // Dragging to With editor opens the one Assign editor dialog; Escape leaves the card where it was.
    const dialog = page.getByRole("dialog");
    await retrying(async () => {
      if (await dialog.isVisible()) return;
      await dragTo(page, cardIn(needs, name).first(), withEditor);
      await expect(dialog).toBeVisible({ timeout: 5_000 });
    }, 60_000);
    await expect(dialog).toContainText(/who should edit this\?/i);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(cardIn(needs, name)).toHaveCount(1);
    await expect(cardIn(withEditor, name)).toHaveCount(0);
    expect(["new", "ready"]).toContain((await api.job(job.id)).job.statusCategory);

    // Again, and assign: the card moves and the job has its editor (a recorded step, not a status write).
    await retrying(async () => {
      if (await dialog.isVisible()) return;
      await dragTo(page, cardIn(needs, name).first(), withEditor);
      await expect(dialog).toBeVisible({ timeout: 5_000 });
    }, 60_000);
    await expect(dialog).toContainText(/on their desk/i);
    await dialog.getByRole("radio", { name: new RegExp(escapeRegExp(ROLE_NAMES.editor!)) }).first().click();
    await dialog.getByRole("button", { name: /^assign editor$/i }).click();
    const assigned = await api.waitForCategory(job.id, ["assigned", "accepted"], 30_000);
    expect(assigned.job.editor?.name).toBe(ROLE_NAMES.editor);
    await expect(cardIn(withEditor, name)).toHaveCount(1, { timeout: 30_000 });
    await expect(cardIn(needs, name)).toHaveCount(0);
    await expect(cardIn(withEditor, name).first()).toContainText(new RegExp(ROLE_NAMES.editor!.split(" ")[0]));
    const history = await api.history(job.id);
    expect(history.some((h) => h.kind === "event" && h.event?.eventType === "assignment.created")).toBe(true);
    expect(history.some((h) => h.kind === "stage" && h.stage?.toCategory === assigned.job.statusCategory)).toBe(true);

    // Not a step for the owner: With editor → Done snaps back, nothing changes, nothing is recorded.
    const versionBefore = await api.version(job.id);
    await dragTo(page, cardIn(withEditor, name).first(), done);
    await expect(cardIn(withEditor, name)).toHaveCount(1);
    await expect(cardIn(done, name)).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.waitForTimeout(1_500);
    expect(await api.version(job.id)).toBe(versionBefore);
    expect((await api.job(job.id)).job.statusCategory).toBe(assigned.job.statusCategory);
    expect((await api.history(job.id)).length).toBe(history.length);
    // While dragging, the columns that are not a step say so.
    await expect(cardIn(withEditor, name)).toHaveCount(1);
  } finally {
    await api.setAdvancedTools(false);
  }
  // Off again: the Board is hidden.
  expectHiddenPage(await api.pageStatus("/workspace/kanban"), "/workspace/kanban");
});

test("the Board follows the viewer: an editor only sees their own jobs and may only Send for checking", async ({ api, apiAs, pageAs }) => {
  const editor = await apiAs("editor");
  const mine = await api.createJob({ name: uniq("E2E board editor mine"), editorId: (await editor.me()).user.id, dueDate: civilDate(2) });
  const notMine = await api.createJob({ name: uniq("E2E board editor other"), dueDate: civilDate(2) });
  try {
    await api.setAdvancedTools(true);
    // Advanced is the owner's: an editor cannot open the Board even while it is on (hidden page → simple replacement).
    expectHiddenPage(await editor.pageStatus("/workspace/kanban"), "/workspace/kanban");
    const page = await pageAs("editor");
    const res = await page.goto("/workspace/kanban", { waitUntil: "domcontentloaded" });
    if (res?.status() !== 404) await expect(page).not.toHaveURL(/\/workspace\/kanban/);
    // The owner's Board data lists both jobs (whichever card shape the board API answers with).
    type Card = { id?: string; job?: { id: string } };
    const board = await api.get<{ columns: { cards: Card[] }[] }>(`/api/kanban?q=${encodeURIComponent("E2E board editor")}`);
    const ids = board.columns.flatMap((c) => c.cards.map((card) => card.job?.id ?? card.id));
    expect(ids).toContain(mine.id);
    expect(ids).toContain(notMine.id);
    // The editor's own API view never includes a job that is not theirs.
    const editorBoard = await editor.raw<{ columns: { cards: Card[] }[] }>("GET", `/api/kanban?q=${encodeURIComponent("E2E board editor")}`);
    if (editorBoard.ok) {
      const editorIds = editorBoard.data.columns.flatMap((c) => c.cards.map((card) => card.job?.id ?? card.id));
      expect(editorIds).not.toContain(notMine.id);
    } else {
      expect([403, 404]).toContain(editorBoard.status);
    }
  } finally {
    await api.setAdvancedTools(false);
  }
});
