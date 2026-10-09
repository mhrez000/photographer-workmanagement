import type { Locator, Page } from "@playwright/test";
import { ROLE_EMAILS, eventually, uniq } from "./api";
import { expect, test } from "./fixtures";

/**
 * Kanban drag and drop (spec §40 "kanban"; ARCHITECTURE §4.6): a mouse drag
 * between columns POSTs /api/kanban/drop; the server resolves the target
 * status, records the transition and the card lands in the new column.
 */

function column(page: Page, key: string): Locator {
  return page.locator(`section#kanban-col-${key}`);
}

function card(page: Page, jobNumber: string): Locator {
  return page.locator(`[aria-roledescription="Draggable job card"][aria-label^="${jobNumber} "]`);
}

async function dragTo(page: Page, source: Locator, target: Locator): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  if (!from) throw new Error("card not visible");
  await page.mouse.move(from.x + from.width / 2, from.y + Math.min(20, from.height / 2));
  await page.mouse.down();
  // Pass the 6px activation distance first, then travel in steps so dnd-kit tracks "over".
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + 24, { steps: 4 });
  await target.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  if (!to) throw new Error("column not visible");
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(120, to.height / 2), { steps: 20 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

test("dragging a card from Assigned to In Progress changes the status on the server and in history", async ({ page, api }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const name = uniq("Kanban Drag");
  const job = await api.createJob({ name, editorId: editor.id });
  expect((await api.job(job.id)).job.statusCategory).toBe("assigned");

  await page.goto(`/workspace/kanban?q=${encodeURIComponent(name)}`);
  const source = card(page, job.jobNumber);
  await expect(column(page, "assigned").locator(source)).toBeVisible();

  await dragTo(page, source, column(page, "in_progress"));

  const moved = await eventually(async () => {
    const d = await api.job(job.id);
    return d.job.statusCategory === "in_progress" ? d : null;
  });
  expect(moved.job.editor?.id).toBe(editor.id);
  await expect(column(page, "in_progress").locator(card(page, job.jobNumber))).toBeVisible();

  const owner = await api.me();
  const history = await api.history(job.id);
  const statusEvent = history.find((h) => h.event?.eventType === "job.status_changed" && (h.event.newValue as { category?: string })?.category === "in_progress");
  expect(statusEvent?.event?.actor?.id).toBe(owner.user.id);
  expect(history.some((h) => h.kind === "stage" && h.stage?.toCategory === "in_progress")).toBe(true);
});

test("an invalid drop snaps back and leaves the status unchanged", async ({ page, api }) => {
  const name = uniq("Kanban Invalid");
  const job = await api.createJob({ name });

  await page.goto(`/workspace/kanban?q=${encodeURIComponent(name)}`);
  const source = card(page, job.jobNumber);
  await expect(column(page, "new").locator(source)).toBeVisible();

  await dragTo(page, source, column(page, "completed"));

  // The server refuses (no edge new → completed); the card is back in New.
  await expect(column(page, "new").locator(card(page, job.jobNumber))).toBeVisible();
  await page.waitForTimeout(1000);
  expect((await api.job(job.id)).job.statusCategory).toBe("new");
  await expect(column(page, "completed").locator(card(page, job.jobNumber))).toHaveCount(0);
});
