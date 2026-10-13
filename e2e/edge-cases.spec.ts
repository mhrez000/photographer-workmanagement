import { ROLE_EMAILS, civilDate, eventTypesOf, eventually, loginApi, stagesOf, uniq, uniqUrl, type Api } from "./api";
import { UI_TEST_TIMEOUT, assignEditorViaDialog, clickUntilCategory, dialogButton, expect, jobHeading, moreActions, nextStepCard, openJob, retrying, stagePill, storageFor, test, whoDidWhat } from "./fixtures";

/**
 * Edge cases: due date changed, Reopen from Done (two reasons), two users editing the same job (409
 * → "This job just changed"), Cancel / Restore, Take back from editor, user deactivated with hand-over,
 * becoming late. Historical records stay intact throughout (plan §9).
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

test("changing the due date is recorded with before/after; the editor is not notified by default", async ({ page, api }) => {
  const editor = await api.inviteUser("editor", "Deadline");
  const edApi = await loginApi(editor.email, editor.tempPassword);
  const job = await api.createJob({ name: uniq("Deadline"), editorId: editor.user.id, dueDate: civilDate(5) });
  const before = (await api.job(job.id)).job.dueDate;

  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), dueDate: civilDate(2) });
  const after = (await api.job(job.id)).job.dueDate;
  expect(after).not.toBe(before);

  const events = await api.activity(job.id);
  const changed = events.items.find((e) => e.eventType === "job.due_date_changed");
  expect(changed?.previousValue).toMatchObject({ value: before });
  expect(changed?.newValue).toMatchObject({ value: after });
  // Default-off group (plan §8): no notice.
  await eventually(async () => (await edApi.notifications()).items.find((n) => n.type === "job_assigned" && n.job?.id === job.id));
  expect((await edApi.notifications()).items.filter((n) => n.type === "deadline_changed" && n.job?.id === job.id)).toHaveLength(0);

  await openJob(page, job.id);
  await expect(page.getByRole("main")).toContainText(/Due/i);
  await edApi.ctx.dispose();
});

test("Reopen from Done: 'Client wants changes' goes to Changes asked, 'Fix the delivery link' stays Done; the earlier completion stays in history", async ({ page, api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Reopen"), editorId: editor.id });
  const ed = await apiAs("editor");
  await ed.sendForChecking(job.id);
  await api.approve(job.id, "n/a");
  const completed = await api.job(job.id);
  expect(completed.job.statusCategory).toBe("completed");
  const firstCompletedAt = completed.job.completedAt;
  expect(firstCompletedAt).toBeTruthy();

  await openJob(page, job.id);
  await expect(stagePill(page, "done")).toBeVisible();
  // Exactly one Reopen, in the ⋯ menu (no three variants, no Un-approve, no Client bounce).
  const menu = page.getByRole("menu");
  await retrying(async () => {
    if (!(await menu.isVisible())) await moreActions(page).click({ timeout: 5_000 });
    await expect(menu).toBeVisible({ timeout: 3_000 });
  });
  await expect(menu.getByRole("menuitem", { name: /reopen/i })).toHaveCount(1);
  await expect(menu.getByRole("menuitem", { name: /un-approve|client bounce|back to draft|move to any status/i })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: /reopen/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /reopen this job/i })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /^client wants changes/i })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /^fix the delivery link/i })).toBeVisible();
  await dialog.getByRole("radio", { name: /^client wants changes/i }).click();
  // The note is required.
  await dialogButton(page, /^reopen & ask for changes$/i).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  const note = "Client asked for two extra crops";
  await dialog.getByRole("textbox", { name: /what does the client want changed/i }).fill(note);
  await dialogButton(page, /^reopen & ask for changes$/i).click();
  await expect(dialog).toBeHidden();

  const reopened = await api.waitForCategory(job.id, "revision");
  expect(reopened.job.completedAt).toBeNull();
  expect(reopened.job.reopenedCount).toBe(1);
  expect(reopened.openRevision?.assignee?.id).toBe(editor.id);
  let history = await api.history(job.id);
  const types = eventTypesOf(history);
  expect(types.indexOf("job.completed")).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("job.completed")).toBeLessThan(types.indexOf("job.reopened"));
  await page.reload();
  await expect(stagePill(page, "changes_asked")).toBeVisible();
  await expect(whoDidWhat(page)).toContainText(/Reopened/i);

  // Finish again: the first completion stays, completedAt moves on.
  await ed.sendForChecking(job.id);
  await api.approve(job.id, "n/a");
  const final = await api.job(job.id);
  expect(final.job.statusCategory).toBe("completed");
  expect(Date.parse(final.job.completedAt!)).toBeGreaterThanOrEqual(Date.parse(firstCompletedAt!));
  history = await api.history(job.id);
  const stages = stagesOf(history);
  expect(stages.filter((s) => s.toCategory === "completed")).toHaveLength(2);
  expect(stages.filter((s) => s.isCurrent)).toHaveLength(1);

  // Fix the delivery link: stays Done, records the new client-visible link.
  await page.reload();
  await retrying(async () => {
    if (!(await menu.isVisible())) await moreActions(page).click({ timeout: 5_000 });
    await expect(menu).toBeVisible({ timeout: 3_000 });
  });
  await menu.getByRole("menuitem", { name: /reopen/i }).click();
  await dialog.getByRole("radio", { name: /^fix the delivery link/i }).click();
  const newLink = uniqUrl("delivery-fixed");
  await dialog.getByRole("textbox", { name: /new delivery link/i }).fill(newLink);
  await dialogButton(page, /^replace the link$/i).click();
  await expect(dialog).toBeHidden();
  await eventually(async () => (await api.links(job.id)).some((s) => s.current?.url === newLink));
  expect((await api.job(job.id)).job.statusCategory).toBe("completed");
});

/** The owner and the extra photographer (who shoots and manages the job) write the same job. */
async function jobForColleague(api: Api, name: string) {
  const colleague = await api.userByEmail(ROLE_EMAILS.photographer);
  return api.createJob({ name, photographerId: colleague.id });
}

test("two users editing the same job: the stale action refreshes the page with one toast and writes nothing", async ({ page, api, apiAs }) => {
  const job = await jobForColleague(api, uniq("Conflict"));
  const editor = await api.userByEmail(ROLE_EMAILS.editor);

  // The owner opens the page (version v) and the editor picker…
  await openJob(page, job.id);
  const card = nextStepCard(page);
  const picker = page.getByRole("dialog");
  await retrying(async () => {
    if (!(await picker.isVisible())) await card.getByRole("button", { name: /^assign editor$/i }).click({ timeout: 5_000 });
    await expect(picker.getByRole("heading", { name: /who should edit this/i })).toBeVisible({ timeout: 3_000 });
  });
  await picker.getByRole("radio", { name: new RegExp(editor.name) }).click();

  // …the photographer changes the job meanwhile (version v+1).
  const colleague = await apiAs("photographer");
  await colleague.patch(`/api/jobs/${job.id}`, { expectedVersion: await colleague.version(job.id), priority: "urgent" });

  // The owner's action is rejected with a conflict: the picker closes, the page refreshes itself and ONE
  // toast says so (plan §9 — never a dialog, never an error that blames the viewer); nothing moved.
  await dialogButton(page, /^assign editor$/i).click();
  await expect(picker).toBeHidden();
  const toasts = page.locator('[aria-live="polite"][aria-label="Notifications"]');
  await expect(toasts).toContainText("This job has changed — the page has been updated");
  await expect(page.getByRole("dialog").filter({ hasText: "This job just changed" })).toHaveCount(0);
  expect((await api.job(job.id)).job.editor).toBeNull();

  // The refreshed page carries the new version, so the same action now succeeds.
  await assignEditorViaDialog(page, nextStepCard(page).getByRole("button", { name: /^assign editor$/i }), editor.name, api, job.id, "assigned");
});

test("two users editing the same job: the stale Edit details save gets the conflict dialog and writes nothing", async ({ page, api, apiAs }) => {
  const job = await jobForColleague(api, uniq("Conflict form"));
  await page.goto(`/jobs/${job.id}/edit`);
  const nameInput = page.getByRole("textbox", { name: /address|job name/i }).first();
  await expect(nameInput).toHaveValue(job.name);

  const colleague = await apiAs("photographer");
  const theirName = uniq("Conflict theirs");
  await colleague.patch(`/api/jobs/${job.id}`, { expectedVersion: await colleague.version(job.id), name: theirName });

  await nameInput.fill(uniq("Conflict mine"));
  await page.getByRole("button", { name: /save/i }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "This job just changed" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}/edit`));
  expect((await api.job(job.id)).job.name).toBe(theirName);
  await dialog.getByRole("button", { name: "Reload latest" }).click();
  await expect(dialog).toBeHidden();
});

test("API contract: a stale expectedVersion is a 409 with the current row and changes nothing", async ({ api, apiAs }) => {
  const job = await jobForColleague(api, uniq("Conflict api"));
  const v = await api.version(job.id);
  const ownerName = uniq("Conflict owner wins");
  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: v, name: ownerName });

  const colleague = await apiAs("photographer");
  const stale = await colleague.raw("PATCH", `/api/jobs/${job.id}`, { expectedVersion: v, name: "E2E colleague loses" });
  expect(stale.status).toBe(409);
  expect(stale.error?.code).toBe("conflict");
  expect(JSON.stringify(stale.error?.current)).toContain(ownerName);
  const staleCancel = await colleague.raw("POST", `/api/jobs/${job.id}/cancel`, { expectedVersion: v, reason: "E2E stale cancel" });
  expect(staleCancel.status).toBe(409);

  const now = await api.job(job.id);
  expect(now.job.name).toBe(ownerName);
  expect(now.job.version).toBe(v + 1);
  expect(["new", "ready"]).toContain(now.job.statusCategory);
});

test("Cancel job needs a reason; the cancelled job leaves the active list; Restore brings it back", async ({ page, api }) => {
  const job = await api.createJob({ name: uniq("Cancel restore") });
  await openJob(page, job.id);
  const menu = page.getByRole("menu");
  await retrying(async () => {
    if (!(await menu.isVisible())) await moreActions(page).click({ timeout: 5_000 });
    await expect(menu).toBeVisible({ timeout: 3_000 });
  });
  await menu.getByRole("menuitem", { name: /cancel job/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /cancel this job/i })).toBeVisible();
  await dialogButton(page, /^cancel job$/i).click();
  await expect(dialog.getByRole("alert")).toBeVisible(); // reason required
  expect(["new", "ready"]).toContain((await api.job(job.id)).job.statusCategory);
  await dialog.getByRole("textbox", { name: /why is it cancelled/i }).fill("E2E: drone permit refused");
  await dialogButton(page, /^cancel job$/i).click();
  await api.waitForCategory(job.id, "cancelled");
  await page.reload();
  await expect(stagePill(page, "cancelled")).toBeVisible();
  await expect(nextStepCard(page)).toContainText(/This job was cancelled/i);
  await clickUntilCategory(page, nextStepCard(page).getByRole("button", { name: /^restore$/i }), api, job.id, ["new", "ready"]);
  const back = await api.job(job.id);
  expect(back.job.statusCategory).not.toBe("cancelled");
  expect(stagesOf(await api.history(job.id)).map((s) => s.toCategory)).toContain("cancelled");
});

test("Take back from editor returns the job to Needs editor and the editor loses it", async ({ page, api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Take back"), editorId: editor.id });
  await openJob(page, job.id);
  const menu = page.getByRole("menu");
  await retrying(async () => {
    if (!(await menu.isVisible())) await moreActions(page).click({ timeout: 5_000 });
    await expect(menu).toBeVisible({ timeout: 3_000 });
  });
  await menu.getByRole("menuitem", { name: /take back from editor/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(new RegExp(`Take this back from ${editor.name}`));
  await dialogButton(page, /^take back$/i).click();
  const after = await api.waitForCategory(job.id, ["ready", "new"]);
  expect(after.job.editor).toBeNull();
  const ed = await apiAs("editor");
  expect([403, 404]).toContain((await ed.raw("POST", `/api/jobs/${job.id}/start`, { expectedVersion: after.job.version })).status);
  await page.reload();
  await expect(stagePill(page, "needs_editor")).toBeVisible();
  await expect(whoDidWhat(page)).toContainText(/Taken back/i);
});

test("a deactivated editor loses access immediately; their jobs are handed over and history stays intact", async ({ api, pageWithState }) => {
  const editor = await api.inviteUser("editor", "Deactivate");
  const job = await api.createJob({ name: uniq("Deactivate"), editorId: editor.user.id });
  const edApi = await loginApi(editor.email, editor.tempPassword);
  await edApi.startEditing(job.id);

  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  await openJob(page, job.id);
  await expect(jobHeading(page)).toBeVisible();

  const target = await api.userByEmail(ROLE_EMAILS.editor);
  await api.deactivateUser(editor.user.id, "Left the studio", target.id);

  expect((await edApi.raw("GET", "/api/auth/me")).status).toBe(401);
  await page.reload();
  await expect(page).toHaveURL(/\/login/);

  const after = await api.job(job.id);
  expect(after.job.editor?.id).toBe(target.id);
  expect(after.job.statusCategory).toBe("in_progress");
  const text = JSON.stringify(await api.history(job.id));
  expect(text).toContain(editor.user.name);
  expect(text).toContain(target.name);
  await edApi.ctx.dispose();
});

test("becoming late: the sweep emits exactly one event per deadline and re-arms after a due date change; Late is a chip, not a stage", async ({ api }) => {
  const job = await api.createJob({ name: uniq("Overdue"), dueDate: civilDate(-2) });
  expect((await api.job(job.id)).job.isOverdue).toBe(true);
  expect(["new", "ready"]).toContain((await api.job(job.id)).job.statusCategory);

  const overdueEvents = async () => (await api.activity(job.id)).items.filter((e) => e.eventType === "job.became_overdue");
  await api.post("/api/system/sweep");
  await api.post("/api/system/sweep");
  const first = await overdueEvents();
  expect(first).toHaveLength(1);
  expect(first[0].metadata).toMatchObject({ cause: "sweep" });

  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), dueDate: civilDate(-1) });
  await api.post("/api/system/sweep");
  await api.post("/api/system/sweep");
  expect(await overdueEvents()).toHaveLength(2);

  // Done jobs are never late (plan §4).
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  await api.assignEditor(job.id, editor.id);
  const ed = await loginApi(ROLE_EMAILS.editor);
  await ed.sendForChecking(job.id);
  await ed.dispose();
  await api.approve(job.id, "n/a");
  const rows = await api.get<{ rows: { id: string }[] }>(`/api/jobs/simple?q=${encodeURIComponent(job.jobNumber)}&late=1`);
  expect(rows.rows.map((r) => r.id)).not.toContain(job.id);
});
