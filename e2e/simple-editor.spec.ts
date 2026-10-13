import type { Page } from "@playwright/test";
import { civilDate, loginApi, uniq, uniqUrl, type Api, type InvitedUser } from "./api";
import {
  UI_TEST_TIMEOUT,
  clickUntilCategory,
  dialogButton,
  expect,
  expectPlainWords,
  gotoReady,
  jobHeading,
  mainNavLabels,
  moreActions,
  retrying,
  sectionNamed,
  stagePill,
  storageFor,
  test,
} from "./fixtures";

/**
 * The editor's home, My jobs (docs/SIMPLIFICATION-PLAN.md §6 "Editor: My jobs"): sections in order
 * (Changes asked · Late · To do · Waiting for Mo to check · Done recently), each hidden when empty,
 * one card per job with one button, Raw files opening straight from the card, "Can't do this one"
 * on the job page, and a footer with the editor's own five-number cut.
 *
 * A fresh editor is invited for every test so the sections and footer are exact.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

async function freshEditor(api: Api, label: string): Promise<{ editor: InvitedUser; session: Api }> {
  const editor = await api.inviteUser("editor", label);
  return { editor, session: await loginApi(editor.email, editor.tempPassword) };
}

function card(page: Page, name: string) {
  return page.getByRole("main").locator("article, li").filter({ hasText: name }).first();
}

test("My jobs: sections in order, one button per card, Raw files from the card, the footer numbers", async ({ api, pageWithState }) => {
  const { editor, session } = await freshEditor(api, "My jobs");
  const stamp = Date.now().toString(36);
  const rawUrl = uniqUrl("raw");

  // To do · New (assigned, not started)
  const todoNew = await api.createJob({ name: `E2E ${stamp} To do new`, editorId: editor.user.id, dueDate: civilDate(3) });
  await api.addLink(todoNew.id, "raw_files", rawUrl, "Raw files");
  // To do · Editing (started), due tomorrow
  const todoEditing = await api.createJob({ name: `E2E ${stamp} To do editing`, editorId: editor.user.id, dueDate: civilDate(1) });
  await session.startEditing(todoEditing.id);
  // Late (due the day before yesterday, not started)
  const late = await api.createJob({ name: `E2E ${stamp} Late one`, editorId: editor.user.id, dueDate: civilDate(-2) });
  // Changes asked
  const changes = await api.createJob({ name: `E2E ${stamp} Changes asked`, editorId: editor.user.id, dueDate: civilDate(2) });
  await session.sendForChecking(changes.id);
  const request = `Please remove the bins on the side path ${stamp}`;
  await api.askForChanges(changes.id, request, ["Remove items"]);
  // Waiting for the owner to check
  const waiting = await api.createJob({ name: `E2E ${stamp} Waiting check`, editorId: editor.user.id, dueDate: civilDate(2) });
  await session.sendForChecking(waiting.id);
  // Done recently
  const done = await api.createJob({ name: `E2E ${stamp} Done one`, editorId: editor.user.id, dueDate: civilDate(2) });
  await session.sendForChecking(done.id);
  await api.approve(done.id, "n/a");

  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  await gotoReady(page, "/my-jobs", page.getByRole("main").getByText(/^Hi /));
  await expectPlainWords(page, "/my-jobs");

  // The editor's menu is My jobs · Calendar, nothing else (plan §3).
  expect(await mainNavLabels(page)).toEqual(["My jobs", "Calendar"]);

  // Top line: "Hi <name>. Next up: …" names the most urgent job (Changes asked first).
  const topline = page.getByRole("main").getByText(/^Hi /);
  await expect(topline).toContainText(editor.user.name.split(" ")[0]);
  await expect(topline).toContainText(/Next up:/);
  await expect(topline).toContainText(changes.name);

  // Sections, in order; each shows its own jobs.
  const main = page.getByRole("main");
  const headings = (await main.getByRole("heading").allInnerTexts()).map((t) => t.trim());
  const order = ["Changes asked", "Late", "To do", /Waiting for .* to check/, "Done recently"].map((h) =>
    headings.findIndex((t) => (typeof h === "string" ? t.startsWith(h) : h.test(t))),
  );
  expect(order.every((i) => i >= 0), `section headings present in ${headings.join(" | ")}`).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  await expect(sectionNamed(page, /^changes asked/i)).toContainText(changes.name);
  await expect(sectionNamed(page, /^changes asked/i)).toContainText(request); // the card quotes the request
  await expect(sectionNamed(page, /^late$/i)).toContainText(late.name);
  await expect(sectionNamed(page, /^late$/i)).toContainText(/2 days late/i);
  await expect(sectionNamed(page, /^to do/i)).toContainText(todoNew.name);
  await expect(sectionNamed(page, /^to do/i)).toContainText(todoEditing.name);
  await expect(card(page, todoNew.name)).toContainText(/\bNew\b/);
  await expect(card(page, todoEditing.name)).toContainText(/\bEditing\b/);
  await expect(card(page, todoEditing.name)).toContainText(/Due tomorrow/i);

  // Each card: one main button, and Raw files opens straight from the card.
  await expect(card(page, todoNew.name).getByRole("button", { name: /^start editing$/i })).toBeVisible();
  await expect(card(page, todoNew.name).getByRole("button", { name: /^send for checking$/i })).toHaveCount(0);
  await expect(card(page, todoNew.name).getByRole("link", { name: /raw files/i })).toHaveAttribute("href", rawUrl);
  await expect(card(page, todoEditing.name).getByRole("button", { name: /^send for checking$/i })).toBeVisible();
  await expect(card(page, changes.name).getByRole("button", { name: /^send for checking$/i })).toBeVisible();

  // Waiting for the check and Done recently are collapsed (<details>) and read only.
  for (const [name, job] of [["Waiting", waiting], ["Done recently", done]] as const) {
    const details = main.locator("details").filter({ has: page.getByRole("heading", { name: new RegExp(name, "i") }) }).first();
    await expect(details).toBeVisible();
    await expect(main.getByText(job.name)).toBeHidden();
    await details.locator("summary").click();
    await expect(main.getByText(job.name)).toBeVisible();
    await expect(card(page, job.name).getByRole("button", { name: /start editing|send for checking/i })).toHaveCount(0);
  }

  // The footer: the editor's own numbers; one finished job → the percentages wait for 5 (plan §7).
  const footer = main.locator("footer").filter({ hasText: /This month:/ });
  await expect(footer).toBeVisible();
  await expect(footer).toContainText(/1 job finished/);
  await expect(footer).toContainText(/after 5 finished jobs|Not enough jobs yet/i);
  await expect(footer).toContainText(/checking time never counts against you/i);

  // Nothing of the old editor dashboard: no capacity bar, bands, KPIs or timer.
  for (const word of [/of \d+h \/ week/, /Overloaded/, /Healthy/, /Awaiting editor/, /Paused/, /Start timer/]) {
    await expect(main.getByText(word), `${word} is gone`).toHaveCount(0);
  }

  // Start editing from the card.
  await clickUntilCategory(page, card(page, todoNew.name).getByRole("button", { name: /^start editing$/i }), api, todoNew.id, "in_progress");
  await page.reload();
  await expect(card(page, todoNew.name)).toContainText(/\bEditing\b/);
  await expect(card(page, todoNew.name).getByRole("button", { name: /^send for checking$/i })).toBeVisible();
  await session.dispose();
});

test("Send for checking from a My jobs card asks for the finished link and will not send without one", async ({ api, pageWithState }) => {
  const { editor, session } = await freshEditor(api, "Card send");
  const job = await api.createJob({ name: uniq("E2E card send"), editorId: editor.user.id, dueDate: civilDate(2) });
  await session.startEditing(job.id);

  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  await gotoReady(page, "/my-jobs", card(page, job.name));
  const send = card(page, job.name).getByRole("button", { name: /^send for checking$/i });
  const dialog = page.getByRole("dialog");
  await retrying(async () => {
    if (!(await dialog.isVisible())) await send.click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 3_000 });
  });
  await expect(dialog.getByRole("heading", { name: /send for checking/i })).toBeVisible();
  // Without a link the confirm stays off and nothing moves.
  const confirm = dialogButton(page, /^send for checking$/i);
  await expect(confirm).toBeDisabled();
  expect((await api.job(job.id)).job.statusCategory).toBe("in_progress");
  const url = uniqUrl("finished");
  await dialog.getByRole("textbox", { name: /finished photos link/i }).fill(url);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  const sent = await api.waitForCategory(job.id, "submitted");
  expect(sent.job.statusCategory).toBe("submitted");
  expect((await api.links(job.id)).find((l) => l.kind === "finished_files")?.current?.url).toBe(url);
  await session.dispose();
});

test("Can't do this one: a reason is required, the job goes back to Needs editor and leaves My jobs", async ({ api, pageWithState }) => {
  const { editor, session } = await freshEditor(api, "Decline");
  const job = await api.createJob({ name: uniq("E2E cannot do"), editorId: editor.user.id, dueDate: civilDate(2) });

  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  await expect(stagePill(page, "with_editor")).toBeVisible();
  // Editors never see the owner's controls.
  await expect(page.getByRole("main").getByRole("button", { name: /^(assign|change) editor/i })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("button", { name: /^approve/i })).toHaveCount(0);

  const menu = page.getByRole("menu");
  await retrying(async () => {
    if (!(await menu.isVisible())) await moreActions(page).click({ timeout: 5_000 });
    await expect(menu).toBeVisible({ timeout: 3_000 });
  });
  await expect(menu.getByRole("menuitem", { name: /cancel job|take back|change editor/i })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: /can't do this one/i })).toBeEnabled();
  await menu.getByRole("menuitem", { name: /can't do this one/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /can't do this one/i })).toBeVisible();
  // The reason is required.
  await dialogButton(page, /^hand it back$/i).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect((await api.job(job.id)).job.statusCategory).toBe("assigned");
  const reason = uniq("E2E double-booked this week");
  await dialog.getByRole("textbox", { name: /why not/i }).fill(reason);
  await dialogButton(page, /^hand it back$/i).click();
  const after = await api.waitForCategory(job.id, ["ready", "new"]);
  expect(after.job.editor).toBeNull();
  expect(JSON.stringify(await api.history(job.id))).toContain(reason);

  // Gone from My jobs; the owner's Home flags it under Needs attention.
  await gotoReady(page, "/my-jobs", page.getByRole("main"));
  await expect(page.getByRole("main").getByText(job.name)).toHaveCount(0);

  // Once editing has started the item stays visible but greyed out, with the way forward spelled out (E6);
  // the Instructions / Messages copy speaks to the editor, not about them (E7); one wording for "Client can see" (E14).
  const started = await api.createJob({ name: uniq("E2E cannot do started"), editorId: editor.user.id, dueDate: civilDate(2) });
  await session.startEditing(started.id);
  await gotoReady(page, `/jobs/${started.id}`, jobHeading(page));
  await retrying(async () => {
    if (!(await menu.isVisible())) await moreActions(page).click({ timeout: 5_000 });
    await expect(menu).toBeVisible({ timeout: 3_000 });
  });
  await expect(menu.getByRole("menuitem", { name: /can't do this one/i })).toBeDisabled();
  await expect(menu.getByText(/Editing has started — ask .* to take this back/)).toBeVisible();
  // "Ask a question" visibly does something: the message box gets the focus (E8).
  await menu.getByRole("menuitem", { name: /ask a question/i }).click();
  await expect(page.getByRole("main").getByRole("combobox", { name: /new message/i })).toBeFocused({ timeout: 5_000 });
  const main = page.getByRole("main");
  await expect(sectionNamed(page, /^instructions for the editor/i)).toContainText(/No instructions from .* yet/);
  await expect(sectionNamed(page, /^instructions for the editor/i).getByRole("button", { name: /add a note for/i })).toBeVisible();
  await expect(main.getByText(/leave a note for the editor/i)).toHaveCount(0);
  await expect(sectionNamed(page, /^messages/i)).toContainText(/Ask .* anything about this job/);
  await expect(main.locator("[data-client-can-see]")).toHaveText(/^(Yes|Not yet|No \(client has no portal\))/);
  await session.dispose();
});

test("an editor without jobs sees an empty My jobs with no sections and the footer, and cannot add jobs", async ({ api, pageWithState }) => {
  const { editor, session } = await freshEditor(api, "Empty");
  expect((await session.me()).user.canCreateJobs).toBe(false); // editors cannot add jobs by default (plan §2)
  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  await gotoReady(page, "/my-jobs", page.getByRole("main"));
  const main = page.getByRole("main");
  for (const h of [/^changes asked/i, /^late$/i, /^to do/i]) await expect(main.getByRole("heading", { name: h })).toHaveCount(0);
  await expect(main.getByText(/Your desk is clear|No jobs yet/i).first()).toBeVisible();
  await expect(page.locator('a[href="/jobs/new"]')).toHaveCount(0);
  const res = await page.goto("/jobs/new");
  expect(res?.status()).toBe(403);
  await session.dispose();
});
