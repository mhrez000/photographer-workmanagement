import { eventually, loginApi, uniq } from "./api";
import { expect, storageFor, test } from "./fixtures";

/**
 * Notifications (spec §40; ARCHITECTURE §6): the bell shows the unread count,
 * items can be marked read one by one or all at once. Uses a fresh editor so
 * the counts are exact.
 */
test("bell count tracks unread notifications; mark one read, then mark all read", async ({ api, pageWithState }) => {
  const editor = await api.inviteUser("editor", "Notify");
  const edApi = await loginApi(editor.email, editor.tempPassword);
  expect((await edApi.me()).unreadCount).toBe(0);

  // Two notifications: assigned to a job, then its priority changes (manager actor → editor notified).
  const job = await api.createJob({ name: uniq("Notify"), editorId: editor.user.id });
  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), priority: "urgent" });

  const unread = await eventually(async () => {
    const list = await edApi.notifications(true);
    return list.items.length >= 2 ? list.items : null;
  });
  const types = unread.map((n) => n.type);
  expect(types).toContain("job_assigned");
  expect(types).toContain("priority_changed");
  const count = (await edApi.me()).unreadCount;
  expect(count).toBe(unread.length);

  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: `Notifications, ${count} unread` })).toBeVisible();

  // Mark one as read from the notification centre.
  await page.getByRole("link", { name: `Notifications, ${count} unread` }).click();
  await expect(page).toHaveURL(/\/notifications/);
  const first = unread[0];
  await page.getByRole("button", { name: `Mark “${first.title}” as read` }).first().click();
  await expect.poll(async () => (await edApi.me()).unreadCount).toBe(count - 1);
  await page.reload();
  await expect(page.getByRole("link", { name: count - 1 > 0 ? `Notifications, ${count - 1} unread` : "Notifications" })).toBeVisible();

  // Mark all read.
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect.poll(async () => (await edApi.me()).unreadCount).toBe(0);
  await page.reload();
  await expect(page.locator(`a[href="/notifications"][aria-label="Notifications"]`)).toBeVisible();
  expect((await edApi.notifications(true)).items).toHaveLength(0);
  // Read state is per-notification and permanent (idempotent re-read).
  const again = await edApi.raw("POST", `/api/notifications/${first.id}/read`);
  expect(again.status).toBe(200);
  await edApi.ctx.dispose();
});

test("the actor is never notified about their own change", async ({ api }) => {
  const job = await api.createJob({ name: uniq("Self notify") });
  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), priority: "high" });
  const after = await api.notifications(true);
  expect(after.items.filter((n) => n.job?.id === job.id)).toHaveLength(0);
});
