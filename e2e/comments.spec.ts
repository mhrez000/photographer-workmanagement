import { ROLE_EMAILS, eventually, uniq } from "./api";
import { expect, openJob, test } from "./fixtures";

/** Comments + @mentions (spec §40 "comments"; ARCHITECTURE §6 `mentioned`). */
test("a comment with an @mention notifies the mentioned user, deep-linking to the job", async ({ page, api, apiAs, pageAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Comments"), editorId: editor.id });
  const body = `Please check the twilight sky ${Date.now().toString(36)}`;
  const firstName = editor.name.split(" ")[0];

  await openJob(page, job.id, "comments");
  const composer = page.getByRole("combobox", { name: "New comment" });
  await composer.click();
  await composer.pressSequentially(`${body} @${firstName}`, { delay: 15 });
  const picker = page.getByRole("listbox", { name: "Mention someone" });
  await picker.getByRole("option", { name: new RegExp(editor.name) }).click();
  await expect(composer).toHaveValue(new RegExp(`@${editor.name}`));
  await page.getByRole("button", { name: "Post", exact: true }).click();

  // The comment is shown and stored with the mention.
  await expect(page.getByText(body)).toBeVisible();
  const comments = await eventually(async () => {
    const list = await api.get<{ body: string; mentionUserIds?: string[]; mentions?: { id: string }[] }[]>(`/api/jobs/${job.id}/comments`);
    return list.find((c) => c.body.includes(body)) ? list : null;
  });
  const stored = comments.find((c) => c.body.includes(body))!;
  const mentioned = stored.mentionUserIds ?? stored.mentions?.map((m) => m.id) ?? [];
  expect(mentioned).toContain(editor.id);

  // The editor gets a `mentioned` notification for this job.
  const ed = await apiAs("editor");
  const notification = await eventually(async () => {
    const list = await ed.notifications();
    return list.items.find((n) => n.type === "mentioned" && n.job?.id === job.id) ?? null;
  });
  expect(notification.readAt).toBeNull();
  expect(notification.linkPath).toContain(job.id);

  // …and it is in their notification centre; opening it lands on the job.
  const edPage = await pageAs("editor");
  await edPage.goto("/notifications");
  const item = edPage.getByRole("listitem").filter({ hasText: job.jobNumber }).filter({ hasText: /mention/i }).first().getByRole("link").first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(edPage).toHaveURL(new RegExp(`/jobs/${job.id}`));
  await expect(edPage.getByText(body)).toBeVisible();

  // Comment shows up in the job's audit trail.
  const activity = await api.activity(job.id);
  expect(activity.items.some((e) => e.eventType === "comment.added")).toBe(true);
  expect(activity.items.some((e) => e.eventType === "comment.mentioned")).toBe(true);
});

test("mentioning someone who cannot see the job is rejected (422)", async ({ api }) => {
  const job = await api.createJob({ name: uniq("Comments 422") });
  const outsider = await api.inviteUser("editor", "Outsider");
  const res = await api.raw("POST", `/api/jobs/${job.id}/comments`, { body: "hi", mentionUserIds: [outsider.user.id] });
  expect(res.status).toBe(422);
});
