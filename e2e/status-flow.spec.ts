import { ROLE_EMAILS, civilDate, uniq, type Api } from "./api";
import { expect, historyList, jobHeading, myWorkCard, test } from "./fixtures";

/**
 * Full happy path across three roles (spec §40 "status changes"; ARCHITECTURE §4):
 * editor accepts / starts / submits from My Work → photographer requests a
 * revision with a reason (dialog) → editor resubmits → photographer approves,
 * delivers, completes → History shows every step with names.
 */

const categoryIs = (api: Api, jobId: string, category: string) => api.waitForCategory(jobId, category);

test("editor ↔ photographer workflow, end to end, fully recorded in History", async ({ api, pageAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const photographer = await api.userByEmail(ROLE_EMAILS.photographer);
  const owner = await api.me();
  const name = uniq("Flow");
  // Due in 5 days → "Upcoming" in the editor's queue.
  const job = await api.createJob({ name, editorId: editor.id, photographerId: photographer.id, dueDate: civilDate(5) });
  expect(job.statusCategory).toBe("assigned");

  /* ---- editor: accept / start / submit from My Work ---- */
  const ed = await pageAs("editor");
  await ed.goto("/workspace/my");
  let card = myWorkCard(ed, name);
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: `More actions for ${job.jobNumber}` }).click();
  await ed.getByRole("menuitem", { name: "Accept" }).click();
  await categoryIs(api, job.id, "accepted");
  // Re-render with the new job version before the next action (a stale version is a 409).
  await ed.reload();

  card = myWorkCard(ed, name);
  await card.getByRole("button", { name: "Start", exact: true }).click();
  await categoryIs(api, job.id, "in_progress");
  await ed.reload();

  card = myWorkCard(ed, name);
  await card.getByRole("button", { name: "Submit", exact: true }).click();
  await categoryIs(api, job.id, "submitted");

  /* ---- photographer: request a revision with a reason ---- */
  const ph = await pageAs("photographer");
  await ph.goto(`/jobs/${job.id}`);
  await expect(jobHeading(ph)).toContainText(name);
  await ph.getByRole("button", { name: "Request revision" }).click();
  const dialog = ph.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Request a revision" })).toBeVisible();
  await dialog.getByPlaceholder("Or type your own reason").fill("Sky looks unnatural");
  await dialog.getByLabel(/What needs to change/).fill("Redo sky replacement on images 4 and 7.");
  await dialog.getByRole("button", { name: "Request revision" }).click();
  await expect(dialog).toBeHidden();
  const inRevision = await categoryIs(api, job.id, "revision");
  expect(inRevision.revisions.map((r) => [r.revisionNumber, r.reason])).toEqual([[1, "Sky looks unnatural"]]);

  /* ---- editor: resubmit from My Work ---- */
  await ed.goto("/workspace/my");
  card = myWorkCard(ed, name);
  await card.getByRole("button", { name: "Resubmit", exact: true }).click();
  const resubmitted = await categoryIs(api, job.id, "resubmitted");
  expect(resubmitted.openRevision).toBeNull();

  /* ---- photographer: approve, deliver, complete ---- */
  await ph.goto(`/jobs/${job.id}`);
  await ph.getByRole("button", { name: "Approve", exact: true }).click();
  await categoryIs(api, job.id, "approved");
  await ph.reload();
  await ph.getByRole("button", { name: "Deliver", exact: true }).click();
  await categoryIs(api, job.id, "delivered");
  await ph.reload();
  await ph.getByRole("button", { name: "Complete", exact: true }).click();
  const done = await categoryIs(api, job.id, "completed");
  expect(done.job.completedAt).toBeTruthy();

  /* ---- History: every step, with who did it ---- */
  const history = await api.history(job.id);
  const events = history.filter((h) => h.kind === "event").map((h) => h.event!);
  const actorOf = (type: string) => events.find((e) => e.eventType === type)?.actor?.id;
  expect(actorOf("job.created")).toBe(owner.user.id);
  expect(actorOf("job.accepted")).toBe(editor.id);
  expect(actorOf("job.work_started")).toBe(editor.id);
  expect(actorOf("job.submitted")).toBe(editor.id);
  expect(actorOf("revision.requested")).toBe(photographer.id);
  expect(actorOf("revision.resolved")).toBe(editor.id);
  expect(actorOf("job.approved")).toBe(photographer.id);
  expect(actorOf("job.completed")).toBe(photographer.id);
  const stageCats = history.filter((h) => h.kind === "stage").map((h) => h.stage!.toCategory);
  for (const cat of ["assigned", "accepted", "in_progress", "submitted", "revision", "resubmitted", "approved", "delivered", "completed"]) {
    expect(stageCats, `stage ${cat} in history`).toContain(cat);
  }

  await ph.goto(`/jobs/${job.id}?tab=history`);
  const list = historyList(ph);
  await expect(list).toBeVisible();
  // Every step, attributed to the person who did it ("<actor> <what>").
  const steps = [
    `${owner.user.name} created the job`,
    `${editor.name} accepted the job`,
    `${editor.name} started`,
    `${editor.name} submitted`,
    `${photographer.name} requested revision #1`,
    `${editor.name} resubmitted revision #1`,
    `${photographer.name} approved`,
    `${photographer.name} delivered`,
    `${photographer.name} completed the job`,
  ];
  for (const step of steps) {
    await expect(list, `history shows "${step}"`).toContainText(step);
  }
  await expect(list).toContainText("Sky looks unnatural");
});
