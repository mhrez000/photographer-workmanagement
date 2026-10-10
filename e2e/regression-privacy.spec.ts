import { ROLE_EMAILS, uniq, type ActivityItem, type Paginated } from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, test } from "./fixtures";

/**
 * Regressions of the roles-v2 security review (docs/ROLES.md §2.4, §3.3, §5.2):
 *  - EDITOR-ACTIVITY-CLIENT-NOTES: activity feeds never show editors notes of
 *    kind `client` (or `internal`) — the notes API already hides them.
 *  - EDITOR-ACTIVITY-OTHERS-WORK-SESSIONS: editors (even with "See other
 *    editors' jobs") never read another person's timer sessions in a feed.
 *  - TEAMVIEW-409-BEFORE-403 / SEC-NOTE-1: the actor check runs before the
 *    version and state checks — a read-only viewer gets 403, never a 409 that
 *    carries the job row or a 422 about the job's state.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const notesTypes = "note.added,note.edited,note.archived,note.restored";
const sessionTypes = "work_session.started,work_session.ended";

test("editors never see client-note text in job activity, the global feed, the dashboard or /activity", async ({ api, apiAs, pageAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Client note leak"), editorId: editor.id });
  const secret = `E2E client brief ${Date.now().toString(36)}: keep whites neutral`;
  await api.addNote(job.id, "client", secret);
  await api.addNote(job.id, "editor", "E2E editor-readable note");

  // The owner sees it in the feed (control).
  expect(JSON.stringify(await api.get<unknown>(`/api/jobs/${job.id}/activity?limit=200&eventType=${notesTypes}`))).toContain(secret);

  for (const role of ["editor", "editor-team"] as const) {
    const ed = await apiAs(role);
    expect(JSON.stringify(await ed.notes(job.id)), role).not.toContain(secret);
    const onJob = await ed.raw<Paginated<ActivityItem>>("GET", `/api/jobs/${job.id}/activity?limit=200&eventType=${notesTypes}`);
    expect(onJob.status, role).toBe(200);
    expect(JSON.stringify(onJob.data), role).not.toContain(secret);
    expect(JSON.stringify(onJob.data), role).toContain("E2E editor-readable note");
    const global = await ed.get<Paginated<ActivityItem>>(`/api/activity?limit=200&eventType=${notesTypes}`);
    expect(JSON.stringify(global), role).not.toContain(secret);
    expect(global.items.filter((i) => i.eventType.startsWith("note.") && (i.newValue as { kind?: string } | null)?.kind === "client"), role).toEqual([]);
  }

  const page = await pageAs("editor");
  await gotoReady(page, "/activity", page.getByRole("heading", { level: 1 }));
  expect(await page.content()).not.toContain(secret);
  await gotoReady(page, "/dashboard", page.getByRole("navigation", { name: "Main" }));
  expect(await page.content()).not.toContain(secret);
});

test("an editor with See other editors' jobs never reads another editor's timer sessions through activity", async ({ api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const team = await apiAs("editor-team");
  expect((await team.me()).user.canViewTeamJobs).toBe(true);
  const job = await api.createJob({ name: uniq("Timer leak"), editorId: editor.id });
  const ed = await apiAs("editor");
  await ed.action(job.id, "accept");
  await ed.action(job.id, "start", { startTimer: true });
  await ed.action(job.id, "submit"); // closes the running session (work_session.ended)

  // The holder and the owner see the sessions (control).
  const own = await ed.get<Paginated<ActivityItem>>(`/api/jobs/${job.id}/activity?limit=200&eventType=${sessionTypes}`);
  expect(own.items.map((i) => i.eventType)).toEqual(expect.arrayContaining(["work_session.started", "work_session.ended"]));
  expect((await api.get<Paginated<ActivityItem>>(`/api/jobs/${job.id}/activity?limit=200&eventType=${sessionTypes}`)).items.length).toBeGreaterThanOrEqual(2);

  // The team viewer can read the job, but no session events — job tab or global feed.
  const onJob = await team.raw<Paginated<ActivityItem>>("GET", `/api/jobs/${job.id}/activity?limit=200&eventType=${sessionTypes}`);
  expect(onJob.status).toBe(200);
  expect(onJob.data.items).toEqual([]);
  const all = await team.get<Paginated<ActivityItem>>(`/api/jobs/${job.id}/activity?limit=200`);
  expect(all.items.some((i) => i.eventType === "job.status_changed")).toBe(true);
  expect(all.items.filter((i) => i.eventType.startsWith("work_session."))).toEqual([]);
  const me = (await team.me()).user.id;
  const global = await team.get<Paginated<ActivityItem>>(`/api/activity?limit=200&eventType=${sessionTypes}`);
  expect(global.items.filter((i) => i.actor?.id !== me)).toEqual([]);
});

test("a read-only viewer gets 403 (not 409 with the job row, not 422) on workflow actions with any version", async ({ api, apiAs, loginAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const team = await apiAs("editor-team");
  const assigned = await api.createJob({ name: uniq("Team view 409"), editorId: editor.id });
  for (const verb of ["accept", "decline", "start", "submit"] as const) {
    const res = await team.raw("POST", `/api/jobs/${assigned.id}/${verb}`, { expectedVersion: 999 });
    expect([res.status, res.error?.code], verb).toEqual([403, "forbidden"]);
    expect(JSON.stringify(res.error ?? {}), verb).not.toContain("createdByUserId");
  }
  expect((await team.raw("PATCH", `/api/jobs/${assigned.id}`, { expectedVersion: 999, priority: "urgent" })).status).toBe(403);

  // Revision resolve on another editor's job.
  const ed = await apiAs("editor");
  await ed.driveToSubmitted(assigned.id);
  await api.action(assigned.id, "begin-review");
  const { revision } = await api.requestRevision(assigned.id, "Colour", "Warmer kitchen");
  const resolve = await team.raw("POST", `/api/revisions/${revision.id}/resolve`, { expectedVersion: 1 });
  expect([resolve.status, resolve.error?.code]).toEqual([403, "forbidden"]);
  // The holder still gets the optimistic-concurrency 409.
  expect((await ed.raw("POST", `/api/revisions/${revision.id}/resolve`, { expectedVersion: 999 })).status).toBe(409);

  // SEC-NOTE-1: a member with every switch, unmanaged completed job whose editor is inactive → 403.
  const temp = await api.inviteUser("editor", "Inactive later");
  const ownerId = (await api.me()).user.id;
  const done = await api.createJob({ name: uniq("Reopen order"), editorId: temp.user.id, photographerId: ownerId });
  const t = await loginAs(temp.email, temp.tempPassword);
  await t.driveToSubmitted(done.id);
  for (const verb of ["begin-review", "approve", "deliver", "complete"] as const) await api.action(done.id, verb);
  await api.deactivateUser(temp.user.id);
  const member = await apiAs("photographer");
  const v = await api.version(done.id);
  const reopen = await member.raw("POST", `/api/jobs/${done.id}/reopen`, { expectedVersion: v, reason: "x" });
  expect([reopen.status, reopen.error?.code]).toEqual([403, "forbidden"]);
  const toNew = await member.raw("POST", `/api/jobs/${done.id}/transition`, { expectedVersion: v, toCategory: "new" });
  expect([toNew.status, toNew.error?.code]).toEqual([403, "forbidden"]);
  // The owner may reopen, so the precondition answers: assign an active editor first.
  const owner = await api.raw("POST", `/api/jobs/${done.id}/reopen`, { expectedVersion: v, reason: "x" });
  expect([owner.status, owner.error?.code]).toEqual([422, "editor_required"]);
  expect((await api.job(done.id)).job).toMatchObject({ statusCategory: "completed", version: v });
});
