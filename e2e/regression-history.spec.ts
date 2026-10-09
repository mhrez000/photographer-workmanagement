import type { Page } from "@playwright/test";
import { loginApi, uniq } from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, test } from "./fixtures";

/**
 * Regressions (audit batch B, History tab wording): an editor's accept → start
 * reads "started editing" (once, attributed to the editor), and a decline
 * reads "declined the job" with its reason.
 */
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

/** History moments are paragraphs inside the "Job history" list. */
function moments(page: Page) {
  return page.getByRole("list", { name: "Job history" }).getByRole("paragraph");
}

test("History shows 'started editing' after the editor accepts and starts", async ({ page, api }) => {
  const editor = await api.inviteUser("editor", "Reg history start");
  const ed = await loginApi(editor.email, editor.tempPassword);
  const job = await api.createJob({ name: uniq("Reg history start"), editorId: editor.user.id });
  await ed.action(job.id, "accept");
  expect((await ed.action(job.id, "start")).job.statusCategory).toBe("in_progress");
  await ed.dispose();

  await gotoReady(page, `/jobs/${job.id}?tab=history`, page.getByRole("list", { name: "Job history" }));
  const startedEditing = moments(page).filter({ hasText: /started editing/i });
  await expect(startedEditing).toHaveCount(1);
  await expect(startedEditing).toContainText(editor.user.name);
  await expect(moments(page).filter({ hasText: /accepted the job/i })).toHaveCount(1);
  // Not the raw event verb, and not twice (stage row + event row).
  await expect(moments(page).filter({ hasText: /started work\b/i })).toHaveCount(0);
});

test("History shows 'declined the job' with the reason", async ({ page, api }) => {
  const editor = await api.inviteUser("editor", "Reg history decline");
  const ed = await loginApi(editor.email, editor.tempPassword);
  const job = await api.createJob({ name: uniq("Reg history decline"), editorId: editor.user.id });
  const reason = uniq("E2E too busy");
  expect(["ready", "new"]).toContain((await ed.action(job.id, "decline", { reason })).job.statusCategory);
  await ed.dispose();

  const list = page.getByRole("list", { name: "Job history" });
  await gotoReady(page, `/jobs/${job.id}?tab=history`, list);
  const declined = moments(page).filter({ hasText: /declined the job/i });
  await expect(declined).toHaveCount(1);
  await expect(declined).toContainText(editor.user.name);
  await expect(list).toContainText(reason);
});
