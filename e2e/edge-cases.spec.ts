import { ROLE_EMAILS, civilDate, eventTypesOf, eventually, loginApi, stagesOf, uniq } from "./api";
import { expect, historyList, jobHeading, openJob, storageFor, test } from "./fixtures";

/**
 * Spec §40 edge cases: deadline changed, reopened after completion, two users
 * editing the same job, user deactivated, becomes overdue. Historical records
 * must remain intact throughout.
 */

test("changing the deadline notifies the editor and is recorded with before/after", async ({ page, api }) => {
  const editor = await api.inviteUser("editor", "Deadline");
  const edApi = await loginApi(editor.email, editor.tempPassword);
  const job = await api.createJob({ name: uniq("Deadline"), editorId: editor.user.id, dueDate: civilDate(5) });
  const before = (await api.job(job.id)).job.dueDate;

  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), dueDate: civilDate(2) });
  const after = (await api.job(job.id)).job.dueDate;
  expect(after).not.toBe(before);

  const n = await eventually(async () => (await edApi.notifications()).items.find((x) => x.type === "deadline_changed" && x.job?.id === job.id));
  expect(n.readAt).toBeNull();

  const events = await api.activity(job.id);
  const changed = events.items.find((e) => e.eventType === "job.due_date_changed");
  expect(changed?.previousValue).toMatchObject({ value: before });
  expect(changed?.newValue).toMatchObject({ value: after });

  await openJob(page, job.id, "activity");
  await expect(page.getByRole("tabpanel")).toContainText(/due date|deadline/i);
  await edApi.ctx.dispose();
});

test("reopening a completed job keeps the earlier completion in history and counts it once when re-completed", async ({ page, api }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Reopen"), editorId: editor.id });
  for (const verb of ["start", "submit", "approve", "complete"] as const) await api.action(job.id, verb);
  const completed = await api.job(job.id);
  expect(completed.job.statusCategory).toBe("completed");
  const firstCompletedAt = completed.job.completedAt;
  expect(firstCompletedAt).toBeTruthy();

  // A reopen needs a reason.
  const noReason = await api.raw("POST", `/api/jobs/${job.id}/reopen`, { expectedVersion: completed.job.version, toCategory: "in_progress" });
  expect(noReason.status).toBeGreaterThanOrEqual(400);
  expect(noReason.status).toBeLessThan(500);

  await openJob(page, job.id);
  // The primary action on a completed job reopens it for more work (completed → in progress).
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /^Reopen/ })).toBeVisible();
  await expect(dialog).toContainText("the earlier completion stays in the history");
  await dialog.getByRole("textbox").first().fill("Client asked for two extra crops");
  await dialog.getByRole("button", { name: /^Reopen/ }).click();
  await expect(dialog).toBeHidden();

  const reopened = await api.waitForCategory(job.id, "in_progress");
  expect(reopened.job.completedAt).toBeNull();
  expect(reopened.job.reopenedCount).toBe(1);

  let history = await api.history(job.id);
  const types = eventTypesOf(history);
  expect(types.indexOf("job.completed")).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("job.completed")).toBeLessThan(types.indexOf("job.reopened"));
  const reopenEvent = history.find((h) => h.event?.eventType === "job.reopened")!.event!;
  expect(JSON.stringify(reopenEvent.metadata)).toContain("Client asked for two extra crops");

  await openJob(page, job.id, "history");
  await expect(historyList(page)).toContainText(/completed the job/i);
  await expect(historyList(page)).toContainText(/reopened/i);

  // Finish again: the first completion stays in the stage history, completedAt moves on,
  // and the Completed list shows the job once (latest completion only, ARCHITECTURE §8).
  for (const verb of ["submit", "approve", "complete"] as const) await api.action(job.id, verb);
  const final = await api.job(job.id);
  expect(final.job.statusCategory).toBe("completed");
  expect(Date.parse(final.job.completedAt!)).toBeGreaterThanOrEqual(Date.parse(firstCompletedAt!));
  history = await api.history(job.id);
  const stages = stagesOf(history);
  expect(stages.filter((s) => s.toCategory === "completed")).toHaveLength(2);
  expect(stages.find((s) => s.isReopen)?.toCategory).toBe("in_progress");
  expect(stages.filter((s) => s.isCurrent)).toHaveLength(1);
  const list = await api.get<{ rows: { id: string }[] }>(`/api/jobs?quick=completed&q=${encodeURIComponent(job.jobNumber)}&limit=50`);
  expect(list.rows.filter((r) => r.id === job.id)).toHaveLength(1);
});

test("two users editing the same job: the stale action gets a 409 conflict dialog", async ({ page, api, apiAs }) => {
  const job = await api.createJob({ name: uniq("Conflict") });

  // The owner opens the page (version v)…
  await openJob(page, job.id);
  await expect(page.getByRole("button", { name: "Mark ready" })).toBeVisible();

  // …a manager changes the job meanwhile (version v+1).
  const manager = await apiAs("manager");
  await manager.patch(`/api/jobs/${job.id}`, { expectedVersion: await manager.version(job.id), priority: "urgent" });

  // The owner's action is rejected with a conflict, shown in the dialog.
  await page.getByRole("button", { name: "Mark ready" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "This job just changed" })).toBeVisible();
  expect((await api.job(job.id)).job.statusCategory).toBe("new");

  // Reload latest, then the action succeeds.
  await dialog.getByRole("button", { name: "Reload latest" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Mark ready" }).click();
  await api.waitForCategory(job.id, "ready");
});

test("two users editing the same job: the stale edit-form save gets the conflict dialog and writes nothing", async ({ page, api, apiAs }) => {
  const job = await api.createJob({ name: uniq("Conflict form") });
  await page.goto(`/jobs/${job.id}/edit`);
  const nameInput = page.getByRole("textbox", { name: /job name/i });
  await expect(nameInput).toHaveValue(job.name);

  // Someone else saves first.
  const manager = await apiAs("manager");
  const theirName = uniq("Conflict theirs");
  await manager.patch(`/api/jobs/${job.id}`, { expectedVersion: await manager.version(job.id), name: theirName });

  await nameInput.fill(uniq("Conflict mine"));
  await page.getByRole("button", { name: "Save changes" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "This job just changed" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}/edit`));
  expect((await api.job(job.id)).job.name).toBe(theirName);

  await dialog.getByRole("button", { name: "Reload latest" }).click();
  await expect(dialog).toBeHidden();
});

test("API contract: a stale expectedVersion is a 409 with the current row and changes nothing", async ({ api, apiAs }) => {
  const job = await api.createJob({ name: uniq("Conflict api") });
  const v = await api.version(job.id);
  const ownerName = uniq("Conflict owner wins");
  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: v, name: ownerName });

  const manager = await apiAs("manager");
  const stale = await manager.raw("PATCH", `/api/jobs/${job.id}`, { expectedVersion: v, name: "E2E manager loses" });
  expect(stale.status).toBe(409);
  expect(stale.error?.code).toBe("conflict");
  expect(JSON.stringify(stale.error?.current)).toContain(ownerName);
  // Stale status changes are rejected the same way.
  const staleCancel = await manager.raw("POST", `/api/jobs/${job.id}/cancel`, { expectedVersion: v, reason: "E2E stale cancel" });
  expect(staleCancel.status).toBe(409);

  const now = await api.job(job.id);
  expect(now.job.name).toBe(ownerName);
  expect(now.job.version).toBe(v + 1);
  expect(now.job.statusCategory).toBe("new");
});

test("a deactivated editor loses access immediately; their jobs are handed over and history stays intact", async ({ api, pageWithState }) => {
  const editor = await api.inviteUser("editor", "Deactivate");
  const job = await api.createJob({ name: uniq("Deactivate"), editorId: editor.user.id });
  const edApi = await loginApi(editor.email, editor.tempPassword);
  await edApi.action(job.id, "start");

  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  await openJob(page, job.id);
  await expect(jobHeading(page)).toBeVisible();

  const target = await api.userByEmail(ROLE_EMAILS.editor);
  const profile = await api.userByEmail(editor.email);
  await api.post(`/api/users/${editor.user.id}/deactivate`, { expectedVersion: profile.version, reassignTo: target.id, reason: "Left the studio" });

  // Session is dead: API 401, pages bounce to /login.
  expect((await edApi.raw("GET", "/api/auth/me")).status).toBe(401);
  await page.reload();
  await expect(page).toHaveURL(/\/login/);

  // The job moved to the replacement editor without losing its stage.
  const after = await api.job(job.id);
  expect(after.job.editor?.id).toBe(target.id);
  expect(after.job.statusCategory).toBe("in_progress");
  const history = await api.history(job.id);
  const text = JSON.stringify(history);
  expect(text).toContain(editor.user.name);
  expect(text).toContain(target.name);
  await edApi.ctx.dispose();
});

test("becoming overdue: the sweep emits exactly one event per deadline and re-arms after a deadline change", async ({ api }) => {
  const job = await api.createJob({ name: uniq("Overdue"), dueDate: civilDate(-2) });
  expect((await api.job(job.id)).job.isOverdue).toBe(true);

  const overdueEvents = async () => (await api.activity(job.id)).items.filter((e) => e.eventType === "job.became_overdue");

  await api.post("/api/system/sweep");
  await api.post("/api/system/sweep");
  const first = await overdueEvents();
  expect(first).toHaveLength(1);
  expect(first[0].metadata).toMatchObject({ cause: "sweep" });

  // New (still past) deadline → the next sweep emits again, once.
  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), dueDate: civilDate(-1) });
  await api.post("/api/system/sweep");
  await api.post("/api/system/sweep");
  expect(await overdueEvents()).toHaveLength(2);
});
