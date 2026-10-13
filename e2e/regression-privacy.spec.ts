import { ROLE_EMAILS, loginApi, uniq, type ActivityItem, type Api, type Paginated } from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, jobHeading, sectionNamed, test } from "./fixtures";

/**
 * Privacy regressions (docs/ROLES.md §2.4, §3.3, §5.2; docs/SIMPLIFICATION-PLAN.md §5 "Private notes"):
 *  - editors never see private notes (kind `internal` / `client`) — not in the notes API, the job's
 *    activity, the global feed or the job page; the simplified job page keeps them in their own
 *    tinted box for owners and photographers only;
 *  - an editor with "See other editors' jobs" never reads another person's work sessions;
 *  - the actor check runs before the version and state checks — a read-only viewer gets 403, never a
 *    409 that carries the job row or a 422 about the job's state;
 *  - editors never see client contact details, other people's emails or the Editors numbers.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const notesTypes = "note.added,note.edited,note.archived,note.restored";
const sessionTypes = "work_session.started,work_session.ended";

/** An editor with "See other editors' jobs" switched on (none is seeded in the small demo). */
async function teamViewer(api: Api) {
  const user = await api.inviteUser("editor", "Team viewer");
  await api.setPermissions(user.user.id, { canViewTeamJobs: true });
  return { user, session: await loginApi(user.email, user.tempPassword) };
}

test("editors never see private-note text: notes API, job activity, global feed, job page", async ({ api, apiAs, pageAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Private note leak"), editorId: editor.id });
  const secret = `E2E private brief ${Date.now().toString(36)}: keep whites neutral`;
  await api.addNote(job.id, "internal", secret);
  await api.addNote(job.id, "client", `${secret} (client)`);
  const instructions = `E2E editor-readable instructions ${Date.now().toString(36)}`;
  await api.addNote(job.id, "photographer", instructions);

  // The owner sees it (control) — on the job page in the Private notes box, not in the instructions.
  expect(JSON.stringify(await api.get<unknown>(`/api/jobs/${job.id}/activity?limit=200&eventType=${notesTypes}`))).toContain(secret);
  const { session: team } = await teamViewer(api);

  for (const [label, ed] of [["editor", await apiAs("editor")], ["team viewer", team]] as const) {
    expect(JSON.stringify(await ed.notes(job.id)), label).not.toContain(secret);
    const onJob = await ed.raw<Paginated<ActivityItem>>("GET", `/api/jobs/${job.id}/activity?limit=200&eventType=${notesTypes}`);
    expect(onJob.status, label).toBe(200);
    expect(JSON.stringify(onJob.data), label).not.toContain(secret);
    expect(JSON.stringify(onJob.data), label).toContain(instructions);
    const global = await ed.raw<Paginated<ActivityItem>>("GET", `/api/activity?limit=200&eventType=${notesTypes}`);
    if (global.status === 200) expect(JSON.stringify(global.data), label).not.toContain(secret);
  }

  const page = await pageAs("editor");
  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  const html = await page.content();
  expect(html).not.toContain(secret);
  expect(html).toContain(instructions);
  await expect(page.getByRole("main").getByRole("heading", { name: /private notes/i })).toHaveCount(0);
  await gotoReady(page, "/my-jobs", page.getByRole("main"));
  expect(await page.content()).not.toContain(secret);
  await team.dispose();
});

test("the owner's Private notes box is separate from the editor thread, so nothing private can be sent by one wrong click", async ({ page, api }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Private box"), editorId: editor.id });
  const secret = `E2E private ${Date.now().toString(36)}`;
  await api.addNote(job.id, "internal", secret);
  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  const privateBox = sectionNamed(page, /^private notes/i);
  await expect(privateBox).toContainText(secret);
  await expect(privateBox).toContainText(/Only owners and photographers see these/i);
  const messages = sectionNamed(page, /^messages/i);
  await expect(messages).not.toContainText(secret);
  // The message composer has no "private" toggle or kind picker.
  await expect(messages.getByRole("checkbox")).toHaveCount(0);
  await expect(messages.locator("select")).toHaveCount(0);
});

test("an editor with See other editors' jobs never reads another editor's work sessions through activity", async ({ api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const { session: team } = await teamViewer(api);
  const job = await api.createJob({ name: uniq("Session leak"), editorId: editor.id });
  const ed = await apiAs("editor");
  await ed.sendForChecking(job.id);

  const onJob = await team.raw<Paginated<ActivityItem>>("GET", `/api/jobs/${job.id}/activity?limit=200&eventType=${sessionTypes}`);
  expect(onJob.status).toBe(200);
  expect(onJob.data.items).toEqual([]);
  const all = await team.get<Paginated<ActivityItem>>(`/api/jobs/${job.id}/activity?limit=200`);
  expect(all.items.some((i) => i.eventType === "job.status_changed")).toBe(true);
  expect(all.items.filter((i) => i.eventType.startsWith("work_session."))).toEqual([]);
  await team.dispose();
});

test("a read-only viewer gets 403 (not 409 with the job row, not 422) on workflow actions with any version", async ({ api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const { session: team } = await teamViewer(api);
  const assigned = await api.createJob({ name: uniq("Team view 409"), editorId: editor.id });
  for (const verb of ["accept", "decline", "start", "submit"] as const) {
    const res = await team.raw("POST", `/api/jobs/${assigned.id}/${verb}`, { expectedVersion: 999 });
    expect([res.status, res.error?.code], verb).toEqual([403, "forbidden"]);
    expect(JSON.stringify(res.error ?? {}), verb).not.toContain("createdByUserId");
  }
  expect((await team.raw("PATCH", `/api/jobs/${assigned.id}`, { expectedVersion: 999, priority: "urgent" })).status).toBe(403);

  const ed = await apiAs("editor");
  await ed.sendForChecking(assigned.id);
  const { revision } = await api.askForChanges(assigned.id, "Warmer kitchen", ["Colour"]);
  const resolve = await team.raw("POST", `/api/revisions/${revision.id}/resolve`, { expectedVersion: 1 });
  expect([resolve.status, resolve.error?.code]).toEqual([403, "forbidden"]);
  // The holder still gets the optimistic-concurrency 409.
  expect((await ed.raw("POST", `/api/revisions/${revision.id}/resolve`, { expectedVersion: 999 })).status).toBe(409);

  // A Done job whose editor is inactive: the extra photographer (not managing it) → 403; the owner → 422 editor_required.
  const temp = await api.inviteUser("editor", "Inactive later");
  const done = await api.createJob({ name: uniq("Reopen order"), editorId: temp.user.id });
  const t = await loginApi(temp.email, temp.tempPassword);
  await t.sendForChecking(done.id);
  await t.dispose();
  await api.approve(done.id, "n/a");
  await api.deactivateUser(temp.user.id);
  const member = await apiAs("photographer");
  const v = await api.version(done.id);
  const reopen = await member.raw("POST", `/api/jobs/${done.id}/reopen`, { expectedVersion: v, reason: "x" });
  expect([403, 404]).toContain(reopen.status);
  const owner = await api.raw("POST", `/api/jobs/${done.id}/reopen`, { expectedVersion: v, reason: "x" });
  expect([owner.status, owner.error?.code]).toEqual([422, "editor_required"]);
  expect((await api.job(done.id)).job).toMatchObject({ statusCategory: "completed", version: v });
  await team.dispose();
});

test("editors never see client contact details, other people's emails or the Editors numbers", async ({ api, apiAs }) => {
  const contactEmail = `e2e-contact-${Date.now().toString(36)}@example.com`;
  const { clientId, clientName } = await api.createClient("Private", {
    contact: { contactName: "E2E Contact Person", email: contactEmail, phone: "+61 400 000 000", notes: "E2E private client note" },
  });
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Private"), clientId, editorId: editor.id });

  const ed = await apiAs("editor");
  const detail = JSON.stringify(await ed.get<unknown>(`/api/clients/${clientId}`));
  expect(detail).toContain(clientName);
  for (const secret of [contactEmail, "E2E Contact Person", "+61 400 000 000", "E2E private client note"]) expect(detail).not.toContain(secret);
  expect(JSON.stringify(await ed.get<unknown>(`/api/clients?q=${encodeURIComponent(clientName)}`))).not.toContain(contactEmail);
  expect(JSON.stringify(await ed.get<unknown>(`/api/clients?q=${encodeURIComponent(contactEmail)}`))).not.toContain(clientId);
  const owner = await api.me();
  expect(JSON.stringify(await ed.get<unknown>(`/api/users/${owner.user.id}`))).not.toContain(ROLE_EMAILS.owner);
  // The Editors page and its numbers are the owner's (plan §7).
  expect([403, 404]).toContain((await ed.pageStatus("/editors")).status);
  expect([403, 404]).toContain((await ed.pageStatus(`/editors/${editor.id}`)).status);
  expect(job.id).toBeTruthy();
});
