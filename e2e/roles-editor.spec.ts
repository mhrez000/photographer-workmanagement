import { ROLE_EMAILS, civilDate, loginApi, uniq } from "./api";
import { FORBIDDEN_TEXT, JOB_NOT_FOUND_TEXT, UI_TEST_TIMEOUT, expect, gotoReady, jobHeading, pickFromCombobox, retrying, storageFor, test } from "./fixtures";

/**
 * Editors (docs/ROLES.md §2.2–§2.4, §3.3, §4.3, §12.2 roles-editor): a focused
 * workspace. They see the jobs assigned to them (plus jobs they held or created,
 * read-only), work them through accept → start → submit → resubmit, and — "all
 * users should be able to create jobs" — create jobs for a photographer (the
 * owner by default), optionally taking the editing themselves.
 *
 * They never assign other editors, approve (least of all their own work),
 * manage settings or people, see other editors' jobs unless switched on, or see
 * private information (client contacts, other people's emails).
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

test("an editor creates a job for the owner (the default photographer), takes it, and the owner reviews it", async ({ api, apiAs }) => {
  const owner = await api.me();
  const ed = await apiAs("editor");
  const me = await ed.me();
  expect(me.user).toMatchObject({ role: "editor", persona: "editor", personaLabel: "Editor", isAdmin: false, canCreateJobs: true, canViewTeamJobs: false });

  // Editors pick an existing client/project (only admins/members create clients).
  const { projectId } = await api.createClientAndProject("Editor creates");
  expect((await ed.raw("POST", "/api/clients", { name: uniq("Editor client") })).status).toBe(403);

  // No photographerId → the default photographer (settings, else the primary owner).
  const job = await ed.createJob({ name: uniq("Editor created"), projectId, editorId: me.user.id, shootDate: civilDate(0) });
  expect(job.photographer?.id).toBe(owner.user.id);
  expect(job.editor?.id).toBe(me.user.id);
  expect(job.statusCategory).toBe("assigned");
  expect(job.detail.job.createdBy.id).toBe(me.user.id);

  // Draft window: the creator edits fields and adds the raw files before starting.
  await ed.patch(`/api/jobs/${job.id}`, { expectedVersion: await ed.version(job.id), name: `${job.name} (twilight)` });
  await ed.addLink(job.id, "raw_files", `https://example.com/raw/${Date.now()}`, "Raw files");

  // Starting closes the draft window for good: fields are the photographer's/owner's again.
  await ed.action(job.id, "accept");
  await ed.action(job.id, "start");
  expect((await ed.raw("PATCH", `/api/jobs/${job.id}`, { expectedVersion: await ed.version(job.id), name: "E2E editor after start" })).status).toBe(403);
  await ed.addLink(job.id, "finished_files", `https://example.com/finished/${Date.now()}`, "Finished");
  await ed.action(job.id, "submit");

  // Once submitted the editor's links freeze, and editors never review.
  const v = await ed.version(job.id);
  expect([403, 422]).toContain((await ed.raw("POST", `/api/jobs/${job.id}/links`, { kind: "finished_files", url: `https://example.com/late/${Date.now()}` })).status);
  for (const verb of ["begin-review", "approve"] as const) {
    expect((await ed.raw("POST", `/api/jobs/${job.id}/${verb}`, { expectedVersion: v })).status, verb).toBe(403);
  }
  expect((await ed.raw("POST", `/api/jobs/${job.id}/revisions`, { expectedVersion: v, reason: "x", description: "y" })).status).toBe(403);

  // The owner (who shot it) reviews: request a revision, the editor resubmits, the owner approves.
  await api.requestRevision(job.id, "Verticals", "Straighten the verticals in image 2.");
  await ed.resolveRevision(job.id, "Straightened");
  expect((await ed.raw("POST", `/api/jobs/${job.id}/approve`, { expectedVersion: await ed.version(job.id) })).status).toBe(403);
  for (const verb of ["approve", "deliver", "complete"] as const) await api.action(job.id, verb);
  expect((await api.job(job.id)).job.statusCategory).toBe("completed");

  // The editor keeps read access to their own completed work.
  expect((await ed.raw("GET", `/api/jobs/${job.id}`)).status).toBe(200);
});

test("an editor chooses the photographer, may only take the job themselves, and can add an inline project", async ({ api, apiAs }) => {
  const ed = await apiAs("editor");
  const me = await ed.me();
  const p02 = await api.userByEmail(ROLE_EMAILS["photographer-noflags"]);
  const editor2 = await api.userByEmail(ROLE_EMAILS["editor-team"]);
  const { clientId, projectId } = await api.createClientAndProject("Editor picks");
  const jobTypeId = await ed.jobTypeId();
  const base = { projectId, jobTypeId };

  const forP02 = await ed.createJob({ name: uniq("Editor for p02"), projectId, photographerId: p02.id, editorId: null });
  expect(forP02.photographer?.id).toBe(p02.id);
  expect(forP02.editor).toBeNull();

  // Photographer must be an active photographer (allow-list): an editor → 422.
  expect((await ed.raw("POST", "/api/jobs", { ...base, name: uniq("Editor bad photographer"), photographerId: editor2.id })).status).toBe(422);
  // Another editor as the editor → 403 (job.assign_editor is never an editor's).
  expect((await ed.raw("POST", "/api/jobs", { ...base, name: uniq("Editor other editor"), editorId: editor2.id })).status).toBe(403);

  // Inline "New project" under an existing client; the editor gets no rights over the project afterwards.
  const projectName = uniq("E2E 14 Ocean St");
  const inline = await ed.createJob({ name: uniq("Editor inline"), clientId, newProject: { name: projectName }, editorId: me.user.id });
  expect(inline.project?.name).toBe(projectName);
  const newProjectId = inline.project?.id ?? "";
  expect(newProjectId).not.toBe("");
  expect((await ed.raw("PATCH", `/api/projects/${newProjectId}`, { expectedVersion: 1, name: "E2E editor renames" })).status).toBe(403);

  // Leaving it unassigned, then claiming it later (the draft window is still open).
  const later = await ed.createJob({ name: uniq("Editor claims later"), projectId, editorId: null });
  expect(later.editor).toBeNull();
  await ed.post(`/api/jobs/${later.id}/claim`, { expectedVersion: await ed.version(later.id) });
  expect((await api.job(later.id)).job.editor?.id).toBe(me.user.id);

  // A job someone else unassigned them from cannot be claimed back.
  await api.assignEditor(later.id, null, "E2E: owner takes it back");
  expect((await ed.raw("POST", `/api/jobs/${later.id}/claim`, { expectedVersion: await api.version(later.id) })).status).toBe(403);
});

test("an editor cannot reassign their job to another editor or bulk-reassign", async ({ api, apiAs, pageAs }) => {
  const editor1 = await api.userByEmail(ROLE_EMAILS.editor);
  const editor2 = await api.userByEmail(ROLE_EMAILS["editor-team"]);
  const job = await api.createJob({ name: uniq("Editor no reassign"), editorId: editor1.id });
  const ed = await apiAs("editor");
  const v = await ed.version(job.id);

  expect((await ed.raw("POST", `/api/jobs/${job.id}/assign`, { role: "editor", userId: editor2.id, expectedVersion: v })).status).toBe(403);
  expect((await ed.raw("POST", "/api/jobs/bulk/reassign", { jobIds: [job.id], userId: editor2.id })).status).toBe(403);
  expect((await ed.raw("POST", `/api/jobs/${job.id}/assign`, { role: "photographer", userId: editor2.id, expectedVersion: v })).status).toBe(403);
  expect((await api.job(job.id)).job.editor?.id).toBe(editor1.id);

  // The UI offers no assignment controls to the editor (the owner's page does).
  const edPage = await pageAs("editor");
  await edPage.goto(`/jobs/${job.id}`);
  await expect(jobHeading(edPage)).toBeVisible();
  await expect(edPage.getByRole("button", { name: /^(Assign|Reassign) editor/ })).toHaveCount(0);
  const more = edPage.getByRole("button", { name: "More actions" });
  if (await more.count()) {
    await more.first().click();
    await expect(edPage.getByRole("menuitem", { name: /editor/i })).toHaveCount(0);
  }
});

test.describe("other editors' jobs", () => {
  test("editor01 cannot see a job held by another editor; editor02 (See other editors' jobs) sees it read-only", async ({ api, apiAs, pageAs }) => {
    const other = await api.inviteUser("editor", "Other editor");
    const held = await api.createJob({ name: uniq("Held by other editor"), editorId: other.user.id });
    const unassigned = await api.createJob({ name: uniq("Nobody holds") });

    const e1 = await apiAs("editor");
    expect((await e1.raw("GET", `/api/jobs/${held.id}`)).status).toBe(404);
    expect(await e1.jobsMatching(held.name)).toHaveLength(0);
    const e1Page = await pageAs("editor");
    const res = await e1Page.goto(`/jobs/${held.id}`);
    expect(res?.status()).toBe(404);
    await expect(e1Page.getByText(JOB_NOT_FOUND_TEXT)).toBeVisible();

    const e2 = await apiAs("editor-team");
    expect((await e2.me()).user.canViewTeamJobs).toBe(true);
    const seen = await e2.job(held.id);
    expect(seen.job.id).toBe(held.id);
    expect(seen.actions.transitions).toHaveLength(0);
    expect((await e2.raw("PATCH", `/api/jobs/${held.id}`, { expectedVersion: seen.job.version, name: "E2E not mine" })).status).toBe(403);
    expect((await e2.raw("POST", `/api/jobs/${held.id}/comments`, { body: "E2E read-only", mentionUserIds: [] })).status).toBe(403);
    expect((await e2.raw("POST", `/api/jobs/${held.id}/accept`, { expectedVersion: seen.job.version })).status).toBe(403);
    // Only jobs an editor holds: a job without an editor stays invisible.
    expect((await e2.raw("GET", `/api/jobs/${unassigned.id}`)).status).toBe(404);
  });

  test("the owner switches See other editors' jobs on and off for one editor", async ({ api }) => {
    const watcher = await api.inviteUser("editor", "Watcher");
    const holder = await api.inviteUser("editor", "Holder");
    const job = await api.createJob({ name: uniq("Watched"), editorId: holder.user.id });
    const session = await loginApi(watcher.email, watcher.tempPassword);

    expect((await session.raw("GET", `/api/jobs/${job.id}`)).status).toBe(404);
    await api.setPermissions(watcher.user.id, { canViewTeamJobs: true });
    expect((await session.raw("GET", `/api/jobs/${job.id}`)).status).toBe(200);
    await api.setPermissions(watcher.user.id, { canViewTeamJobs: false });
    expect((await session.raw("GET", `/api/jobs/${job.id}`)).status).toBe(404);
    // Member switches do not exist for editors.
    expect((await api.raw("POST", `/api/users/${watcher.user.id}/permissions`, { canViewAllJobs: true, expectedVersion: await api.userVersion(watcher.user.id) })).status).toBe(422);
    await session.dispose();
  });
});

test("an editor without Create jobs gets no New job and a 403 from the API", async ({ api, pageWithState }) => {
  const editor = await api.inviteUser("editor", { label: "No create", flags: { canCreateJobs: false } });
  const session = await loginApi(editor.email, editor.tempPassword);
  expect((await session.me()).user.canCreateJobs).toBe(false);
  const { projectId } = await api.createClientAndProject("No create");
  const jobTypeId = await session.jobTypeId();
  expect((await session.raw("POST", "/api/jobs", { name: uniq("Not allowed"), projectId, jobTypeId })).status).toBe(403);
  await session.dispose();

  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  const res = await page.goto("/jobs/new");
  expect(res?.status()).toBe(403);
  await expect(page.getByText(FORBIDDEN_TEXT)).toBeVisible();
});

test("editors never see private information, team pages, insights or settings", async ({ api, apiAs, pageAs }) => {
  const contactEmail = `e2e-contact-${Date.now().toString(36)}@example.com`;
  const { clientId, clientName, projectId } = await api.createClientAndProject("Private", {
    contactName: "E2E Contact Person",
    email: contactEmail,
    phone: "+61 400 000 000",
    notes: "E2E private client note",
  });
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Private"), projectId, editorId: editor.id });
  await api.addNote(job.id, "internal", "E2E internal note never for editors");

  const ed = await apiAs("editor");
  // Client: name (and colour) only — no contact details or notes, in detail, list and options.
  const detail = JSON.stringify(await ed.get<unknown>(`/api/clients/${clientId}`));
  expect(detail).toContain(clientName);
  for (const secret of [contactEmail, "E2E Contact Person", "+61 400 000 000", "E2E private client note"]) expect(detail).not.toContain(secret);
  const list = JSON.stringify(await ed.get<unknown>(`/api/clients?q=${encodeURIComponent(clientName)}`));
  expect(list).not.toContain(contactEmail);
  // Searching by the contact email finds nothing for an editor.
  expect(JSON.stringify(await ed.get<unknown>(`/api/clients?q=${encodeURIComponent(contactEmail)}`))).not.toContain(clientId);
  const options = await ed.get<Record<string, unknown>[]>("/api/clients/options");
  const option = options.find((o) => o.id === clientId);
  expect(option).toBeTruthy();
  expect(Object.keys(option ?? {}).sort()).toEqual(["colour", "id", "name"]);

  // Internal notes and other people's emails are private.
  expect(JSON.stringify(await ed.notes(job.id))).not.toContain("E2E internal note never for editors");
  const owner = await api.me();
  expect(JSON.stringify(await ed.get<unknown>(`/api/users/${owner.user.id}`))).not.toContain(ROLE_EMAILS.owner);
  // Another person's page is closed to editors.
  expect((await ed.raw("GET", `/api/workloads/${owner.user.id}`)).status).toBe(403);

  // Pages: team directories, workloads, insights and settings are 403; no links to them.
  const page = await pageAs("editor");
  for (const path of ["/team/photographers", "/team/editors", "/team/workloads", "/team/performance", "/insights/analytics", "/settings/users", "/settings/roles", "/workspace/team"]) {
    const res = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(res?.status(), path).toBe(403);
  }
  await gotoReady(page, "/dashboard", page.getByRole("navigation", { name: "Main" }));
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const href of ["/team/photographers", "/team/editors", "/team/workloads", "/insights/analytics", "/settings/organisation", "/workspace/team"]) {
    await expect(nav.locator(`a[href="${href}"]`), href).toHaveCount(0);
  }
  // …but New job is there ("all users can create jobs").
  await expect(page.locator('a[href="/jobs/new"]').first()).toBeVisible();
  await expect(page.getByRole("banner").getByText("Whole business")).toHaveCount(0);
});

test("an editor creates a job through the form: the photographer is pre-filled with the owner and Assign to me works", async ({ api, pageAs }) => {
  const owner = await api.me();
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const { clientName, projectName } = await api.createClientAndProject("Editor form");
  const name = uniq("Editor via form");
  const page = await pageAs("editor");

  const form = page.getByRole("form", { name: "Create job" });
  await gotoReady(page, "/jobs/new", form);
  await retrying(async () => {
    await pickFromCombobox(page, form.getByRole("button", { name: "Client", exact: true }), clientName);
  }, 60_000);
  await pickFromCombobox(page, form.getByRole("button", { name: "Project", exact: true }), projectName);
  await form.getByRole("combobox", { name: "Job type" }).selectOption({ label: "Real Estate" });
  await form.getByRole("textbox", { name: "Job name" }).fill(name);
  // Photographer is required and pre-filled with the default photographer (the owner).
  await expect(form.getByRole("button", { name: "Photographer", exact: true })).toContainText(owner.user.name);
  await form.getByRole("radio", { name: /assign to me/i }).check();
  await form.getByRole("button", { name: "Create job" }).click();

  await expect(page).toHaveURL(/\/jobs\/[A-Za-z0-9_-]+$/);
  await expect(jobHeading(page)).toContainText(name);
  const jobId = page.url().split("/jobs/")[1].split(/[?#]/)[0];
  const detail = await api.job(jobId);
  expect(detail.job.photographer?.id).toBe(owner.user.id);
  expect(detail.job.editor?.id).toBe(editor.id);
  expect(detail.job.createdBy.id).toBe(editor.id);
});
