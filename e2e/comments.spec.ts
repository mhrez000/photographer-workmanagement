import { ROLE_EMAILS, eventually, uniq } from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, jobHeading, sectionNamed, test } from "./fixtures";

/**
 * Messages (docs/SIMPLIFICATION-PLAN.md §5 section 4): ONE thread between the owner, photographers
 * and the editor, with @mentions; a question is just a message and shows up on the owner's Home under
 * Needs attention ("Question from Sam"). A mention notifies the person and deep-links to the job.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

test("a message with an @mention notifies the editor and deep-links to the job; the thread has no kinds to pick", async ({ page, api, apiAs, pageAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Messages"), editorId: editor.id });
  const body = `Please check the twilight sky ${Date.now().toString(36)}`;
  const firstName = editor.name.split(" ")[0];

  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  const messages = sectionNamed(page, /^messages/i);
  await expect(messages).toBeVisible();
  await expect(messages).toContainText(/The client never sees these/i);
  // One box: no kind picker (comment / question / clarification…), no private toggle.
  await expect(messages.locator("select")).toHaveCount(0);
  await expect(messages.getByRole("checkbox")).toHaveCount(0);
  const composer = messages.getByRole("combobox", { name: "New message" });
  await composer.click();
  await composer.pressSequentially(`${body} @${firstName}`, { delay: 15 });
  const picker = page.getByRole("listbox", { name: "Mention someone" });
  await picker.getByRole("option", { name: new RegExp(editor.name) }).click();
  await expect(composer).toHaveValue(new RegExp(`@${editor.name}`));
  await messages.getByRole("button", { name: /^send$/i }).click();

  await expect(messages).toContainText(body);
  const comments = await eventually(async () => {
    const list = await api.get<{ body: string | null; mentionUserIds?: string[]; mentions?: { id: string }[] }[]>(`/api/jobs/${job.id}/comments`);
    return list.find((c) => c.body?.includes(body)) ? list : null;
  });
  const stored = comments.find((c) => c.body?.includes(body))!;
  const mentioned = stored.mentionUserIds ?? stored.mentions?.map((m) => m.id) ?? [];
  expect(mentioned).toContain(editor.id);

  // The editor gets a `mentioned` notification (default-on group "New message or @mention").
  const ed = await apiAs("editor");
  const notification = await eventually(async () => (await ed.notifications()).items.find((n) => n.type === "mentioned" && n.job?.id === job.id) ?? null);
  expect(notification.readAt).toBeNull();
  expect(notification.linkPath).toContain(job.id);

  const edPage = await pageAs("editor");
  await edPage.goto("/notifications");
  const item = edPage.getByRole("listitem").filter({ hasText: job.jobNumber }).filter({ hasText: /mention/i }).first().getByRole("link").first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(edPage).toHaveURL(new RegExp(`/jobs/${job.id}`));
  await expect(edPage.getByRole("main")).toContainText(body);

  const activity = await api.activity(job.id);
  expect(activity.items.some((e) => e.eventType === "comment.added")).toBe(true);
  expect(activity.items.some((e) => e.eventType === "comment.mentioned")).toBe(true);
});

test("an editor's question is just a message, and it lands on the owner's Home under Needs attention", async ({ page, api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Question"), editorId: editor.id });
  const ed = await apiAs("editor");
  const question = `Window pulls on the reception room, or keep the view soft? ${Date.now().toString(36)}`;
  const root = await ed.addComment(job.id, question, { kind: "question" });

  await gotoReady(page, "/home", sectionNamed(page, /^needs attention/i));
  const attention = sectionNamed(page, /^needs attention/i);
  const row = attention.getByRole("listitem").filter({ hasText: job.name }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(new RegExp(`Question from ${editor.name}`));
  await expect(row).toContainText(question.slice(0, 40));

  // Answering it in the thread (a reply under the question) clears the row.
  await api.addComment(job.id, "Keep the view soft — the couple loved the haze.", { parentCommentId: root.id });
  await page.reload();
  await expect(sectionNamed(page, /^needs attention/i).getByRole("listitem").filter({ hasText: job.name })).toHaveCount(0);
});

test("mentioning someone who cannot see the job is rejected (422)", async ({ api }) => {
  const job = await api.createJob({ name: uniq("Comments 422") });
  const outsider = await api.inviteUser("editor", "Outsider");
  const res = await api.raw("POST", `/api/jobs/${job.id}/comments`, { body: "hi", mentionUserIds: [outsider.user.id] });
  expect(res.status).toBe(422);
});
