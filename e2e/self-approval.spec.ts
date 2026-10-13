import { SELF_APPROVAL_CONFIRM_MESSAGE } from "../src/lib/constants";
import { ROLE_EMAILS, civilDate, loginApi, uniq, type Api } from "./api";
import { UI_TEST_TIMEOUT, clickUntilCategory, dialogButton, expect, gotoReady, jobHeading, nextStepCard, retrying, storageFor, test } from "./fixtures";

/**
 * Decision 3 (docs/SIMPLIFICATION-PLAN.md §12): owners and co-owners may approve a job they edited
 * themselves after a one-line "You edited this yourself. Approve anyway?" check, recorded in history.
 * Editors and regular photographers stay blocked.
 *
 * "Edited themselves" = the approver is the job's editor or a past editor. An editor cannot be an
 * admin, so the scenario is a person who edited the job as an editor and was later made a
 * photographer + co-owner (roles change: `POST /api/users/:id/role`, `/admin`).
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

/** A job edited (started + sent for checking) by `person`, then handed to Sam so `person` becomes a past editor. */
async function jobEditedBy(api: Api, person: { user: { id: string }; email: string; tempPassword: string }) {
  const job = await api.createJob({ name: uniq("E2E self approve"), editorId: person.user.id, dueDate: civilDate(2) });
  const session = await loginApi(person.email, person.tempPassword);
  await session.sendForChecking(job.id);
  await session.dispose();
  const sam = await api.userByEmail(ROLE_EMAILS.editor);
  await api.assignEditor(job.id, sam.id, "E2E: hand over before the check");
  return job;
}

test("a co-owner who edited the job must confirm; the approval is recorded as self-approved", async ({ api, pageWithState }) => {
  const person = await api.inviteUser("editor", "Self approve");
  const job = await jobEditedBy(api, person);
  // Promote: editor → photographer → co-owner.
  await api.setRole(person.user.id, "photographer");
  await api.setAdmin(person.user.id, true);
  const me = await loginApi(person.email, person.tempPassword);
  expect((await me.me()).user.isAdmin).toBe(true);

  // API: without the confirmation the approve-side step is refused and nothing moves; with it, it goes through.
  const refused = await me.raw("POST", `/api/jobs/${job.id}/approve`, { expectedVersion: await me.version(job.id) });
  expect([400, 422]).toContain(refused.status);
  expect(JSON.stringify(refused.error)).toContain("confirmSelfApproval");
  expect((await api.job(job.id)).job.statusCategory).toBe("submitted");

  // UI: the Next step card asks the one-line question before approving.
  const page = await pageWithState(await storageFor(person.email, person.tempPassword));
  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  const card = nextStepCard(page);
  const dialog = page.getByRole("dialog");
  await retrying(async () => {
    if (!(await dialog.isVisible())) await card.getByRole("button", { name: /^approve$/i }).click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 3_000 });
  });
  await expect(dialog).toContainText(SELF_APPROVAL_CONFIRM_MESSAGE);
  await dialogButton(page, /approve anyway|^approve/i).click();
  const done = await api.waitForCategory(job.id, ["approved", "completed"], 30_000);
  expect(["approved", "completed"]).toContain(done.job.statusCategory);

  // History records the self-approval.
  const history = await api.history(job.id);
  const approved = history.find((h) => h.event?.eventType === "job.approved")?.event;
  expect(approved?.actor?.id).toBe(person.user.id);
  expect(JSON.stringify(approved?.metadata)).toContain("selfApproved");
  await me.dispose();
});

test("an editor can never approve, least of all their own edit; a regular photographer who edited it is blocked too", async ({ api }) => {
  const person = await api.inviteUser("editor", "Blocked");
  const job = await jobEditedBy(api, person);
  // Still an editor (a past editor of this job): 403.
  let session = await loginApi(person.email, person.tempPassword);
  const asEditor = await session.raw("POST", `/api/jobs/${job.id}/approve`, { expectedVersion: await api.version(job.id), confirmSelfApproval: true });
  expect(asEditor.status).toBe(403);
  // The current editor (Sam) cannot approve either.
  const sam = await loginApi(ROLE_EMAILS.editor);
  const asSam = await sam.raw("POST", `/api/jobs/${job.id}/approve`, { expectedVersion: await api.version(job.id), confirmSelfApproval: true });
  expect(asSam.status).toBe(403);
  await sam.dispose();
  await session.dispose();

  // As a regular photographer ("Only their own shoots") who is also the job's photographer, even with
  // Review submissions: hard denial (403). A photographer who is not on the job cannot even see it (404).
  await api.setRole(person.user.id, "photographer");
  await api.setPermissions(person.user.id, { canReviewSubmissions: true, canAssignEditors: true, canCreateJobs: true });
  session = await loginApi(person.email, person.tempPassword);
  const hidden = await session.raw("POST", `/api/jobs/${job.id}/approve`, { expectedVersion: await api.version(job.id), confirmSelfApproval: true });
  expect(hidden.status).toBe(404);
  await api.post(`/api/jobs/${job.id}/assign`, { role: "photographer", userId: person.user.id, expectedVersion: await api.version(job.id) });
  const asPhotographer = await session.raw("POST", `/api/jobs/${job.id}/approve`, { expectedVersion: await api.version(job.id), confirmSelfApproval: true });
  expect(asPhotographer.status).toBe(403);
  const askChanges = await session.raw("POST", `/api/jobs/${job.id}/revisions`, { expectedVersion: await api.version(job.id), reason: "x", description: "y" });
  expect(askChanges.status).toBe(403);
  expect((await api.job(job.id)).job.statusCategory).toBe("submitted");
  await session.dispose();

  // The owner, who never edited it, approves without any confirmation.
  const ok = await api.raw("POST", `/api/jobs/${job.id}/approve`, { expectedVersion: await api.version(job.id) });
  expect(ok.status).toBe(200);
});

test("the owner's Home card and job page approve a normally edited job with no self-approval question", async ({ page, api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("E2E not self"), editorId: editor.id, dueDate: civilDate(2) });
  await (await apiAs("editor")).sendForChecking(job.id);
  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  await clickUntilCategory(page, nextStepCard(page).getByRole("button", { name: /^approve$/i }), api, job.id, ["approved", "completed"]);
  await expect(page.getByRole("dialog").getByText(SELF_APPROVAL_CONFIRM_MESSAGE)).toHaveCount(0);
  const approved = (await api.history(job.id)).find((h) => h.event?.eventType === "job.approved")?.event;
  expect(JSON.stringify(approved?.metadata ?? {})).not.toContain('"selfApproved":true');
});
