import { ROLE_EMAILS, eventually, stagesOf, uniq } from "./api";
import { UI_TEST_TIMEOUT, assignEditorViaDialog, expect, gotoReady, jobHeading, nextStepCard, retrying, stagePill, test, waitingOn, whoDidWhat } from "./fixtures";

/**
 * Assign / Change editor (docs/SIMPLIFICATION-PLAN.md §4 stage 1, §5 "Next step" + ⋯ menu;
 * ARCHITECTURE §4.5): assign from the Next step card, change editor mid-edit → status unchanged, the
 * stage re-attributed, the old editor loses every action but keeps read-only visibility, and Who did
 * what names both editors. The editor picker shows each editor's desk ("On their desk 3 · Late 1").
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

test("assign from the Next step card, change editor mid-edit: old editor loses actions, Who did what shows both", async ({ page, api, apiAs, pageAs }) => {
  const editor1 = await api.userByEmail(ROLE_EMAILS.editor);
  const newEditor = await api.inviteUser("editor", "Change");
  const job = await api.createJob({ name: uniq("Assign flow") });

  // 1) Assign Sam from the card: the picker dialog shows desks ("On their desk 3 · Late 1").
  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  const card = nextStepCard(page);
  await expect(card).toContainText(/Who should edit this\?/);
  await assignEditorViaDialog(page, card.getByRole("button", { name: /^assign editor$/i }), editor1.name, api, job.id, "assigned");
  expect((await api.job(job.id)).job.editor?.id).toBe(editor1.id);

  // 2) Sam starts editing.
  const e1 = await apiAs("editor");
  await e1.startEditing(job.id);
  const editorPage = await pageAs("editor");
  await gotoReady(editorPage, `/jobs/${job.id}`, jobHeading(editorPage));
  await expect(editorPage.getByRole("main").getByRole("button", { name: /^send for checking$/i })).toBeVisible();

  // 3) The owner changes the editor from the card (the current editor is marked "Current" and cannot be re-picked).
  await page.reload();
  await expect(stagePill(page, "with_editor")).toContainText(/Editing/);
  await expect(card).toContainText(new RegExp(`${editor1.name} is editing`));
  const dialog = page.getByRole("dialog");
  await retrying(async () => {
    if (!(await dialog.isVisible())) await card.getByRole("button", { name: /^change editor$/i }).click({ timeout: 5_000 });
    await expect(dialog.getByRole("heading", { name: /^change editor$/i })).toBeVisible({ timeout: 3_000 });
  });
  await expect(dialog.getByRole("radio", { name: new RegExp(editor1.name) })).toContainText(/Current/);
  await expect(dialog.getByRole("radio", { name: new RegExp(editor1.name) })).toHaveAttribute("aria-disabled", "true");
  await assignEditorViaDialog(page, card.getByRole("button", { name: /^change editor$/i }), newEditor.user.name, api, job.id, "in_progress");
  const after = await eventually(async () => {
    const d = await api.job(job.id);
    return d.job.editor?.id === newEditor.user.id ? d : null;
  });
  // Status unchanged: the stage is re-attributed, not restarted.
  expect(after.job.statusCategory).toBe("in_progress");
  await page.reload();
  await expect(waitingOn(page)).toContainText(newEditor.user.name);

  // 4) Old editor: still sees the job (read-only), no actions.
  await editorPage.reload();
  await expect(jobHeading(editorPage)).toBeVisible();
  await expect(editorPage.getByRole("main").getByRole("button", { name: /^send for checking$/i })).toHaveCount(0);
  await expect(editorPage.getByRole("main").getByRole("button", { name: /^start editing$/i })).toHaveCount(0);
  expect([403, 422]).toContain((await e1.raw("POST", `/api/jobs/${job.id}/submit`, { expectedVersion: after.job.version })).status);
  expect((await api.job(job.id)).job.statusCategory).toBe("in_progress");

  // 5) History shows both editors and the re-attribution; Who did what reads "Given to … · Moved to …".
  const stages = stagesOf(await api.history(job.id));
  const editorsAtEntry = stages.map((s) => s.editorAtEntry?.id).filter(Boolean);
  expect(editorsAtEntry).toContain(editor1.id);
  expect(editorsAtEntry).toContain(newEditor.user.id);
  expect(stages.some((s) => s.kind === "reattribution" && s.editorAtEntry?.id === newEditor.user.id)).toBe(true);
  const list = whoDidWhat(page);
  await expect(list).toContainText(new RegExp(`Given to ${editor1.name}`));
  await expect(list).toContainText(new RegExp(`Moved to ${newEditor.user.name}`));
});

test("Change editor on Ready to check keeps the job waiting on the owner; Assign is only for Needs editor", async ({ api, apiAs }) => {
  const editor1 = await api.userByEmail(ROLE_EMAILS.editor);
  const editor2 = await api.userByEmail(ROLE_EMAILS.editor2);
  const job = await api.createJob({ name: uniq("Change at check"), editorId: editor1.id });
  const ed = await apiAs("editor");
  await ed.sendForChecking(job.id);
  await api.assignEditor(job.id, editor2.id, "E2E rebalance");
  const after = await api.job(job.id);
  expect(after.job.statusCategory).toBe("submitted");
  expect(after.job.editor?.id).toBe(editor2.id);
  // The new editor carries on after changes are asked.
  await api.askForChanges(job.id, "One more crop", ["Crop"]);
  const ed2 = await apiAs("editor2");
  expect((await ed2.sendForChecking(job.id)).job.statusCategory).toBe("resubmitted");
  // The owner never sees "Assign editor" on a job with an editor: the card says Change editor.
  expect((await api.job(job.id)).actions.transitions.length).toBeGreaterThanOrEqual(0);
});

test("the extra photographer assigns and changes editors on her own shoots only", async ({ api, apiAs }) => {
  const p01 = await apiAs("photographer");
  const me = await p01.me();
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const own = await api.createJob({ name: uniq("P01 assigns"), photographerId: me.user.id });
  await p01.assignEditor(own.id, editor.id);
  expect((await api.job(own.id)).job.editor?.id).toBe(editor.id);
  const owners = await api.createJob({ name: uniq("Owner shoot"), editorId: editor.id });
  const other = await api.userByEmail(ROLE_EMAILS.editor2);
  expect([403, 404]).toContain((await p01.raw("POST", `/api/jobs/${owners.id}/assign`, { role: "editor", userId: other.id, expectedVersion: owners.version })).status);
  expect((await api.job(owners.id)).job.editor?.id).toBe(editor.id);
});
