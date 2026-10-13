import type { Page } from "@playwright/test";
import { ROLE_EMAILS, ROLE_NAMES, civilDate, eventTypesOf, stagesOf, uniq, uniqUrl, type Api } from "./api";
import {
  UI_TEST_TIMEOUT,
  assignEditorViaDialog,
  clickUntilCategory,
  dialogButton,
  expect,
  expectPlainWords,
  fillField,
  gotoReady,
  jobHeading,
  nextStepCard,
  pickPerson,
  retrying,
  sectionNamed,
  stagePill,
  test,
  waitingOn,
  whoDidWhat,
} from "./fixtures";

/**
 * The happy path of the simplified product (docs/SIMPLIFICATION-PLAN.md §1, §4, §5, §6, §12):
 *
 *   New job (8 fields) → Create & send to Sam → the editor presses Start editing → pastes the
 *   finished link and presses Send for checking (the button stays off without a link) → the
 *   owner's Home shows it under Ready to check → Approve asks "Share with <client>?" because the
 *   client uses the portal → Approve & send → Done, and "Who did what" lists every step.
 *
 * A second test runs one round of changes: Ask for changes (one required box + chips) → the
 * editor sees the note, the link box is pre-filled → Send for checking → Round 2 → Approve.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const EDITOR = ROLE_NAMES.editor!; // Sam Whitfield
const OWNER = ROLE_NAMES.owner!; // Mo Carter

/** The New job form (plan §5): one screen, eight fields (`<form aria-label="Create job">`). */
function newJobForm(page: Page) {
  return page.getByRole("form", { name: /create job|new job/i }).first();
}

/** "Finished photos link" box on the editor's Next step card. */
function finishedLinkBox(page: Page) {
  return nextStepCard(page).getByRole("textbox", { name: /finished photos link/i }).first();
}

async function createPortalClient(api: Api, label: string) {
  return api.createClient(label, { portal: true, feedback: true });
}

test("owner: New job → Create & send → editor: Start editing, Send for checking → owner: Home → Approve & send → Done; Who did what has every step", async ({ page, api, apiAs, pageAs }) => {
  const { clientName } = await createPortalClient(api, "Flow");
  const address = uniq("12 Harbour Street, Mosman NSW 2088");
  const rawUrl = uniqUrl("raw");
  const instructions = `E2E: lift the exteriors and swap the sky on the hero ${Date.now().toString(36)}`;

  /* ---- 1. New job: 8 fields, the button names the editor ---- */
  await gotoReady(page, "/jobs/new", newJobForm(page));
  const form = newJobForm(page);
  await expectPlainWords(page, "/jobs/new");

  // The eight fields are all on one screen (no tabs, no project).
  for (const label of [/^client/i, /address \/ job name/i, /type of shoot/i, /shoot date/i, /^due date/i, /^editor/i, /raw files link/i, /instructions for the editor/i]) {
    await expect(form.getByText(label).first(), `field ${label}`).toBeVisible();
  }
  await expect(form.getByText(/^project$/i)).toHaveCount(0);

  await retrying(async () => {
    await pickPerson(page, form.locator('[data-field="client"]'), clientName);
    await expect(form.locator('[data-field="client"]')).toContainText(clientName, { timeout: 3_000 });
  }, 60_000);
  await fillField(form, /address \/ job name/i, address);
  // Shoot date defaults to today and the due date follows the type of shoot (plan §5).
  await expect(form.getByLabel(/shoot date/i)).toHaveValue(civilDate(0));
  const dueDefault = await form.getByLabel(/^due date/i).inputValue();
  expect(dueDefault > civilDate(0), `due date ${dueDefault} is after today`).toBe(true);
  await fillField(form, /raw files link/i, rawUrl);
  await fillField(form, /instructions for the editor/i, instructions);

  // Before an editor is picked the button reads "Create job"; after, "Create & send to Sam".
  await expect(form.getByRole("button", { name: /^create job$/i })).toBeVisible();
  await pickPerson(page, form.locator('[data-field="editorId"]'), EDITOR);
  const createAndSend = form.getByRole("button", { name: new RegExp(`^Create & send to ${EDITOR}`) });
  await expect(createAndSend).toBeVisible();
  await createAndSend.click();

  await expect(page).toHaveURL(/\/jobs\/(?!new$)[A-Za-z0-9_-]+$/, { timeout: 60_000 }); // never /jobs/new: the form has moved on
  const jobId = page.url().split("/jobs/")[1].split(/[?#]/)[0];
  const created = await api.job(jobId);
  expect(created.job.name).toBe(address);
  expect(created.job.client?.name).toBe(clientName);
  expect(created.job.editor?.name).toBe(EDITOR);
  expect(created.job.statusCategory).toBe("assigned");
  expect(created.job.project?.name).toBe(address); // silent project from the address
  const links = await api.links(jobId);
  expect(links.find((l) => l.kind === "raw_files")?.current?.url).toBe(rawUrl);

  /* ---- the owner's job page: With editor · Not started, Waiting on Sam ---- */
  await expect(jobHeading(page)).toContainText(address);
  await expect(stagePill(page, "with_editor")).toContainText(/With editor/);
  await expect(stagePill(page, "with_editor")).toContainText(/Not started/);
  await expect(waitingOn(page)).toContainText(EDITOR);
  await expect(nextStepCard(page)).toContainText(new RegExp(`Waiting on ${EDITOR}`));
  await expect(nextStepCard(page).getByRole("button", { name: /^change editor$/i })).toBeVisible();
  await expect(page.getByRole("main")).toContainText(instructions);
  await expect(page.getByRole("tablist")).toHaveCount(0); // one scrolling page, no tabs
  await expectPlainWords(page, `/jobs/${jobId}`);

  /* ---- 2. the editor: Start editing, then Send for checking needs a link ---- */
  const ed = await pageAs("editor");
  const edApi = await apiAs("editor");
  await gotoReady(ed, `/jobs/${jobId}`, jobHeading(ed));
  await expect(waitingOn(ed)).toContainText(/You/);
  const card = nextStepCard(ed);
  await expect(card).toContainText(/Raw files are ready/i);
  await expect(card.getByRole("link", { name: /open raw files/i })).toHaveAttribute("href", rawUrl);
  await clickUntilCategory(ed, card.getByRole("button", { name: /^start editing$/i }), edApi, jobId, "in_progress");

  await ed.reload();
  await expect(stagePill(ed, "with_editor")).toContainText(/Editing/);
  const send = nextStepCard(ed).getByRole("button", { name: /^send for checking$/i });
  await expect(send).toBeVisible();
  await expect(send, "Send for checking stays off until a link is filled in").toBeDisabled();
  const finishedUrl = uniqUrl("finished");
  await finishedLinkBox(ed).fill(finishedUrl);
  await expect(send).toBeEnabled();
  await clickUntilCategory(ed, send, edApi, jobId, "submitted");

  const sent = await api.job(jobId);
  expect(sent.job.statusCategory).toBe("submitted");
  expect((await api.links(jobId)).find((l) => l.kind === "finished_files")?.current?.url).toBe(finishedUrl);
  await ed.reload();
  await expect(nextStepCard(ed)).toContainText(/sent to .* for checking/i);
  await expect(nextStepCard(ed).getByRole("button")).toHaveCount(0);

  /* ---- 3. the owner's Home: Ready to check → Approve asks the share question ---- */
  await gotoReady(page, "/home", sectionNamed(page, /^ready to check/i));
  await expectPlainWords(page, "/home");
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: /\d+ to check/ })).toBeVisible();
  const ready = sectionNamed(page, /^ready to check/i);
  // The footer says how many are in Jobs ("See all 3 in Jobs", or "Showing the 20 oldest · 9 more in Jobs" once capped).
  await expect(ready.getByRole("link", { name: /(see all \d+ in jobs|more in jobs)/i })).toHaveAttribute("href", "/jobs?stage=ready_to_check");
  // Home lists the oldest 20 waiting checks (the shared demo accumulates older ones); ours is either a
  // Home row with Open finished photos · Approve · Ask for changes, or one click away under Jobs → Ready to check.
  const row = ready.getByRole("listitem").filter({ hasText: address }).first();
  await expect(ready.getByRole("listitem").first()).toBeVisible();
  const onHome = await row.isVisible().catch(() => false);
  if (onHome) {
    await expect(row).toContainText(new RegExp(`Edited by ${EDITOR}`));
    await expect(row.getByRole("link", { name: /open finished photos/i })).toHaveAttribute("href", finishedUrl);
    await expect(row.getByRole("button", { name: /ask for changes/i })).toBeVisible();
  } else {
    await gotoReady(page, "/jobs?stage=ready_to_check", page.getByRole("main").getByRole("navigation", { name: "Stages" }));
    await expect(page.getByRole("main").getByText(address).locator("visible=true")).toBeVisible();
    await gotoReady(page, `/jobs/${jobId}`, jobHeading(page));
    await expect(nextStepCard(page).getByRole("link", { name: /open finished photos/i })).toHaveAttribute("href", finishedUrl);
    await expect(nextStepCard(page).getByRole("button", { name: /ask for changes/i })).toBeVisible();
  }
  const approveButton = (onHome ? row : nextStepCard(page)).getByRole("button", { name: /^approve$/i });

  const dialog = page.getByRole("dialog");
  await retrying(async () => {
    if (!(await dialog.isVisible())) await approveButton.click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 3_000 });
  });
  await expect(dialog).toContainText(new RegExp(`Share the finished photos with ${clientName}`));
  await expect(dialogButton(page, /^approve only$/i)).toBeVisible();
  await dialogButton(page, /^approve & send$/i).click();
  const done = await api.waitForCategory(jobId, "completed", 30_000);
  expect(done.job.completedAt).toBeTruthy();

  // Approve & send = Approved → Delivered → Completed, three recorded rows (plan §9).
  const history = await api.history(jobId);
  const cats = stagesOf(history).map((s) => s.toCategory);
  for (const c of ["assigned", "in_progress", "submitted", "approved", "delivered", "completed"]) expect(cats, `stage ${c}`).toContain(c);
  // The audit log (plan §9: nothing is merged) has every milestone, incl. the delivery step and the sharing it did.
  const audited = (await api.activity(jobId)).items.map((e) => e.eventType);
  expect(audited).toEqual(expect.arrayContaining(["job.created", "job.work_started", "job.submitted", "job.approved", "job.delivered", "job.client_sharing_changed", "job.completed"]));
  expect(eventTypesOf(history)).toEqual(expect.arrayContaining(["job.created", "job.work_started", "job.submitted", "job.approved", "job.completed"]));

  /* ---- 4. Done on the job page; Who did what lists every step ---- */
  await gotoReady(page, `/jobs/${jobId}`, jobHeading(page));
  await expect(stagePill(page, "done")).toContainText(/Done/);
  await expect(page.getByRole("main").getByText("Waiting on:", { exact: true })).toHaveCount(0);
  await expect(nextStepCard(page)).toContainText(new RegExp(`Done .*edited by ${EDITOR}`, "i"));
  const list = whoDidWhat(page);
  await expect(list).toBeVisible();
  for (const step of [new RegExp(`Created by ${OWNER}`), new RegExp(`Given to ${EDITOR}`), /Started editing/i, /Sent for checking/i, new RegExp(`Approved by ${OWNER}`), /Sent to client/i]) {
    await expect(list, `Who did what shows ${step}`).toContainText(step);
  }
  await expect(list.getByRole("link", { name: /full history/i })).toHaveAttribute("href", `/jobs/${jobId}/history`);
});

test("one round of changes: Ask for changes (required box + chips) → editor sees the note → Send for checking → Round 2 → Approve", async ({ page, api, apiAs, pageAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const name = uniq("E2E 7 Cliff Road, Freshwater NSW 2096");
  // No portal on this client: Approve finishes straight away (plan §5).
  const job = await api.createJob({ name, editorId: editor.id, dueDate: civilDate(2) });
  await api.addLink(job.id, "raw_files", uniqUrl("raw"), "Raw files");
  const ed = await apiAs("editor");
  const firstLink = uniqUrl("finished-v1");
  await ed.sendForChecking(job.id, firstLink);

  /* ---- owner: Ask for changes ---- */
  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  await expect(stagePill(page, "ready_to_check")).toContainText(/Ready to check/);
  await expect(waitingOn(page)).toContainText(/You/);
  const card = nextStepCard(page);
  await expect(card).toContainText(new RegExp(`${EDITOR} sent this`));
  await expect(card.getByRole("link", { name: /open finished photos/i })).toHaveAttribute("href", firstLink);
  await expect(card.getByRole("button", { name: /^approve$/i })).toBeVisible();

  const dialog = page.getByRole("dialog");
  await retrying(async () => {
    if (!(await dialog.isVisible())) await card.getByRole("button", { name: /ask for changes/i }).click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 3_000 });
  });
  await expect(dialog).toContainText(/What needs changing\?/);
  // The box is required: submitting empty does nothing but complain.
  await dialogButton(page, /^ask for changes$/i).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect((await api.job(job.id)).job.statusCategory).toBe("submitted");
  // The old priority / reason list / assign-to fields are gone; chips are optional; Needed back by defaults to tomorrow.
  await expect(dialog.getByText(/priority/i)).toHaveCount(0);
  await expect(dialog.getByText(/assign to/i)).toHaveCount(0);
  await expect(dialog).toContainText(/Needed back by tomorrow/i);
  await dialog.getByRole("button", { name: /^Sky$/ }).click();
  await dialog.getByRole("button", { name: /^Straighten$/ }).click();
  // Tap-to-add means ADD: the chips' words land in the box (a tap alone would be enough to send).
  await expect(dialog.getByRole("textbox", { name: /what needs changing/i })).toHaveValue("Sky.\nStraighten.");
  const note = `Sky is blown out on the front elevation and the hallway verticals lean ${Date.now().toString(36)}`;
  await dialog.getByRole("textbox", { name: /what needs changing/i }).fill(note);
  await dialogButton(page, /^ask for changes$/i).click();
  const inRevision = await api.waitForCategory(job.id, "revision");
  expect(inRevision.revisions).toHaveLength(1);
  expect(inRevision.revisions[0].reason).toBe("Sky, Straighten");
  expect(inRevision.revisions[0].description).toBe(note);

  await page.reload();
  await expect(stagePill(page, "changes_asked")).toContainText(/Changes asked/);
  await expect(waitingOn(page)).toContainText(EDITOR);
  await expect(nextStepCard(page)).toContainText(new RegExp(`Back with ${EDITOR}`));
  await expect(sectionNamed(page, /^changes asked/i)).toContainText(note);
  await expect(sectionNamed(page, /^changes asked/i).getByText("Open", { exact: true })).toHaveCount(1);

  /* ---- editor: the note, the pre-filled link, Send for checking ---- */
  const edPage = await pageAs("editor");
  await gotoReady(edPage, `/jobs/${job.id}`, jobHeading(edPage));
  const edCard = nextStepCard(edPage);
  await expect(edCard).toContainText(new RegExp(`${OWNER} asked for changes`));
  await expect(edCard).toContainText(note);
  await expect(edCard).toContainText(/Round 1/);
  const box = edCard.getByRole("textbox", { name: /finished photos link/i }).first();
  await expect(box).toHaveValue(firstLink);
  const secondLink = uniqUrl("finished-v2");
  await box.fill(secondLink);
  await clickUntilCategory(edPage, edCard.getByRole("button", { name: /^send for checking$/i }), ed, job.id, "resubmitted");

  const resubmitted = await api.job(job.id);
  expect(resubmitted.openRevision).toBeNull();
  const slots = await api.links(job.id, true);
  const finished = slots.find((s) => s.kind === "finished_files");
  expect(finished?.current?.url).toBe(secondLink);
  expect(finished?.history.map((h) => h.url)).toContain(firstLink); // older version kept under "Earlier versions"

  /* ---- owner: Round 2, then Approve (no portal → finishes straight away) ---- */
  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  await expect(page.getByRole("main").getByText(/^Round 2$/).first()).toBeVisible();
  await expect(sectionNamed(page, /^files/i)).toContainText(/Earlier versions \(1\)/i);
  await expect(sectionNamed(page, /^changes asked/i)).toContainText(/Fixed and sent back/i);
  await clickUntilCategory(page, nextStepCard(page).getByRole("button", { name: /^approve$/i }), api, job.id, ["approved", "completed"]);
  const done = await api.waitForCategory(job.id, "completed", 30_000);
  expect(done.job.revisionCount).toBe(1);
  await page.reload();
  await expect(stagePill(page, "done")).toBeVisible();
  await expect(nextStepCard(page)).toContainText(/1 round of changes/i);
  await expect(nextStepCard(page).getByRole("button", { name: /copy finished link/i })).toBeVisible();
  const list = whoDidWhat(page);
  await expect(list).toContainText(/Changes asked \(round 1\)/i);
  await expect(list).toContainText(/Sent back for checking/i);
  await expect(list).toContainText(new RegExp(`Approved by ${OWNER}`));
  await expect(list).not.toContainText(/Sent to client/i);
});

test("a job created with Decide later waits in Needs editor; Assign editor from the Next step card moves it on", async ({ page, api }) => {
  const name = uniq("E2E 3 Wolseley Road, Point Piper NSW 2027");
  const job = await api.createJob({ name });
  expect(["new", "ready"]).toContain(job.statusCategory);

  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  await expect(stagePill(page, "needs_editor")).toContainText(/Needs editor/);
  await expect(waitingOn(page)).toContainText(/You/);
  const card = nextStepCard(page);
  await expect(card).toContainText(/Who should edit this\?/);
  // The picker is a dialog showing each editor's desk ("On their desk 3 · Late 1").
  await assignEditorViaDialog(page, card.getByRole("button", { name: /^assign editor$/i }), EDITOR, api, job.id, "assigned");
  const after = await api.job(job.id);
  expect(after.job.editor?.name).toBe(EDITOR);
  // Assigning skips "Ready for Assignment" (plan §4).
  expect(stagesOf(await api.history(job.id)).map((s) => s.toCategory)).not.toContain("ready");

  await page.reload();
  await expect(stagePill(page, "with_editor")).toBeVisible();
  await expect(waitingOn(page)).toContainText(EDITOR);
  await expect(whoDidWhat(page)).toContainText(new RegExp(`Given to ${EDITOR} by ${OWNER}`));
});
