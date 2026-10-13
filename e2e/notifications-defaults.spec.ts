import { civilDate, eventually, uniq } from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, retrying, storageFor, test } from "./fixtures";

/**
 * Fewer, louder notifications (docs/SIMPLIFICATION-PLAN.md §1, §8): only the eight default-on
 * groups fire for someone who never touched their preferences; a due date change or a Rush tick
 * stays silent; the 26 types remain selectable in My account → Notifications; and "Mark old
 * updates as read" clears unread notices of the now-hidden types without touching the loud ones.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

test("only default-on groups fire: given a job, ready to check, changes asked, approved, message — not due date or Rush", async ({ api, loginAs }) => {
  const editor = await api.inviteUser("editor", "Defaults");
  const ed = await loginAs(editor.email, editor.tempPassword);
  expect((await ed.me()).unreadCount).toBe(0);

  // 1. A job was given to you.
  const job = await api.createJob({ name: uniq("E2E defaults"), editorId: editor.user.id, dueDate: civilDate(3) });
  const given = await eventually(async () => (await ed.notifications(true)).items.find((n) => n.type === "job_assigned" && n.job?.id === job.id));
  expect(given.readAt).toBeNull();

  // Due date change and Rush: default OFF — nothing arrives.
  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), dueDate: civilDate(2) });
  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), priority: "urgent" });
  // 5. New message.
  await api.addComment(job.id, `Can you start with the twilight set? ${Date.now().toString(36)}`);
  const message = await eventually(async () => (await ed.notifications(true)).items.find((n) => n.type === "comment_added" && n.job?.id === job.id));
  expect(message).toBeTruthy();
  const types = (await ed.notifications(true)).items.filter((n) => n.job?.id === job.id).map((n) => n.type);
  expect(types).not.toContain("deadline_changed");
  expect(types).not.toContain("priority_changed");

  // 2. Ready to check (to the owner), 3. Changes asked (to the editor), 4. Approved (to the editor).
  await ed.sendForChecking(job.id);
  const ready = await eventually(async () => (await api.notifications(true)).items.find((n) => n.type === "work_submitted" && n.job?.id === job.id));
  expect(ready.title).toMatch(/ready to check/i);
  await api.askForChanges(job.id, "Warmer kitchen", ["Colour"]);
  const changes = await eventually(async () => (await ed.notifications(true)).items.find((n) => n.type === "revision_requested" && n.job?.id === job.id));
  expect(changes.title).toMatch(/changes asked/i);
  await ed.sendForChecking(job.id);
  await api.approve(job.id, "n/a");
  const approved = await eventually(async () => (await ed.notifications(true)).items.find((n) => n.type === "work_approved" && n.job?.id === job.id));
  expect(approved.title).toMatch(/approved/i);
  // "A job was closed" is default OFF.
  expect((await ed.notifications(true)).items.filter((n) => n.job?.id === job.id).map((n) => n.type)).not.toContain("job_completed");
  // The bell count equals the unread list.
  expect((await ed.me()).unreadCount).toBe((await ed.notifications(true)).items.length);
});

test("8. taken off you or cancelled still fires; the actor is never notified about their own change", async ({ api, loginAs }) => {
  const a = await api.inviteUser("editor", "Taken A");
  const b = await api.inviteUser("editor", "Taken B");
  const edA = await loginAs(a.email, a.tempPassword);
  const job = await api.createJob({ name: uniq("E2E taken off"), editorId: a.user.id });
  await api.assignEditor(job.id, b.user.id, "E2E rebalance");
  const moved = await eventually(async () => (await edA.notifications(true)).items.find((n) => (n.type === "job_reassigned" || n.type === "job_unassigned") && n.job?.id === job.id));
  expect(moved).toBeTruthy();
  const cancelled = await api.createJob({ name: uniq("E2E cancelled notice"), editorId: a.user.id });
  await api.action(cancelled.id, "cancel", { reason: "E2E: client postponed" });
  await eventually(async () => (await edA.notifications(true)).items.find((n) => n.type === "job_cancelled" && n.job?.id === cancelled.id));
  // The owner made every change: nothing lands in the owner's own bell for these jobs.
  const own = (await api.notifications(true)).items.filter((n) => n.job?.id === job.id || n.job?.id === cancelled.id);
  expect(own).toHaveLength(0);
});

test("My account → Notifications still lists every type; switching one on makes it fire; Mark old updates as read clears only the hidden types", async ({ api, loginAs, pageWithState }) => {
  const editor = await api.inviteUser("editor", "Prefs");
  const ed = await loginAs(editor.email, editor.tempPassword);
  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));

  // The preferences page: 8 on by default, the rest off but selectable.
  const prefs = await ed.get<{ type: string; enabled: boolean; mandatory: boolean }[]>(`/api/users/${editor.user.id}/notification-prefs`);
  expect(prefs.length).toBeGreaterThanOrEqual(20);
  expect(prefs.find((p) => p.type === "job_assigned")?.enabled).toBe(true);
  expect(prefs.find((p) => p.type === "priority_changed")?.enabled).toBe(false);
  expect(prefs.find((p) => p.type === "deadline_changed")?.enabled).toBe(false);
  await gotoReady(page, "/settings/account", page.getByRole("main").getByRole("heading", { name: /^notifications$/i }));
  const prefsCard = page.getByRole("main").getByRole("region", { name: /^notifications$/i });
  // The eight groups are plain switches; the hidden kinds sit under "More updates", still selectable.
  // An editor sees the six groups that can ever reach them; "Ready to check" and "Client feedback" tell the
  // PHOTOGRAPHER about the editor's work, so they are not offered to editors (the descriptions are written for the reader).
  for (const group of ["A job was given to you", "Changes asked", "Approved", "New message or @mention", "Late jobs", "taken off you"]) {
    await expect(prefsCard.getByText(new RegExp(group, "i")).first(), group).toBeVisible();
  }
  await expect(prefsCard.getByText(/^Ready to check$/)).toHaveCount(0);
  await expect(prefsCard.getByText(/^Client feedback$/)).toHaveCount(0);
  await expect(prefsCard).toContainText(/A job lands on your desk/);
  await expect(prefsCard).toContainText(/More updates \(0 of \d+ on\)/);
  await prefsCard.getByRole("button", { name: /more updates/i }).click();
  await expect(prefsCard.getByText(/A job was marked Rush/i)).toBeVisible();

  // Switch Rush notices on for this editor only.
  await ed.setNotificationPrefs(editor.user.id, { priority_changed: true });
  const job = await api.createJob({ name: uniq("E2E old updates"), editorId: editor.user.id });
  await eventually(async () => (await ed.notifications(true)).items.find((n) => n.type === "job_assigned" && n.job?.id === job.id));
  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), priority: "urgent" });
  await eventually(async () => (await ed.notifications(true)).items.find((n) => n.type === "priority_changed" && n.job?.id === job.id));
  expect((await ed.me()).unreadCount).toBe(2);

  // "Mark old updates as read" (My account → Notifications): the hidden-type notice is read, the loud one stays unread.
  await gotoReady(page, "/settings/account", page.getByRole("main").getByRole("button", { name: /mark old updates as read/i }));
  const button = page.getByRole("main").getByRole("button", { name: /mark old updates as read/i });
  await expect(page.getByRole("main")).toContainText(/1 older update .* still unread/i);
  await expect(button).toBeEnabled();
  await retrying(async () => {
    if ((await ed.notifications(true)).items.some((n) => n.type === "priority_changed")) await button.click({ timeout: 5_000 });
    await expect.poll(async () => (await ed.notifications(true)).items.map((n) => n.type).sort(), { timeout: 8_000 }).toEqual(["job_assigned"]);
  });
  expect((await ed.me()).unreadCount).toBe(1);
  // Nothing was deleted: the read notice is still listed.
  expect((await ed.notifications()).items.some((n) => n.type === "priority_changed" && n.readAt)).toBe(true);
  await gotoReady(page, "/notifications", page.getByRole("main"));
  await expect(page.getByRole("link", { name: "Notifications, 1 unread" })).toBeVisible();

  // Mark all read still works and is idempotent.
  await page.getByRole("button", { name: /mark all read/i }).click();
  await expect.poll(async () => (await ed.me()).unreadCount).toBe(0);
  const again = await ed.raw("POST", `/api/notifications/${(await ed.notifications()).items[0].id}/read`);
  expect(again.status).toBe(200);
});
