import type { Page } from "@playwright/test";
import {
  BASE_URL,
  PORTAL_JOB_DETAIL_KEYS,
  civilDate,
  escapeRegExp,
  eventually,
  loginApi,
  uniq,
  type Api,
  type InvitedUser,
} from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, jobHeading, retrying, test } from "./fixtures";

/**
 * Client portal (docs/ROLES.md §7, §12.2 portal + portal-isolation).
 *
 * A client user belongs to one client and sees, at /portal only, the jobs the
 * studio explicitly shared with that client (the job, or its whole project):
 * agreed milestones (Booked → Shot → Editing → Delivered, shoot and delivery
 * dates), the finished-work links the studio shared at delivery, delivery notes
 * and their own feedback threads. Never: internal notes, staff comments, editor
 * names, statuses, workloads, audit logs, other clients' work. Every staff page
 * redirects to /portal and every staff API refuses them; a job outside their
 * shared set is a 404.
 *
 * Every test builds its own client (portal switched on through the admin API)
 * and invites its own client user, so nothing depends on the seeded story.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

interface PortalClient {
  clientId: string;
  clientName: string;
  projectId: string;
  user: InvitedUser;
  session: Api;
}

async function portalClient(api: Api, label: string, opts: { feedback?: boolean } = {}): Promise<PortalClient> {
  const { clientId, clientName, projectId } = await api.createClientAndProject(`Portal ${label}`, {
    contactName: "E2E Portal Contact",
    email: `e2e-portal-contact-${Date.now().toString(36)}@example.com`,
  });
  await api.setClientPortal(clientId, { portalEnabled: true, feedbackEnabled: opts.feedback ?? true });
  const user = await api.inviteUser("client", { label: `Portal ${label}`, clientId });
  const session = await loginApi(user.email, user.tempPassword);
  return { clientId, clientName, projectId, user, session };
}

/** A shared job driven to Delivered through the Deliver step (share the job; reviewer-added gallery link by default). */
async function deliveredSharedJob(api: Api, projectId: string, label: string) {
  const editor = await api.inviteUser("editor", `Portal ${label}`);
  const job = await api.createJob({ name: uniq(`Portal ${label}`), projectId, editorId: editor.user.id, shootDate: civilDate(-3), deliveryDueDate: civilDate(2) });
  const ed = await loginApi(editor.email, editor.tempPassword);
  await ed.driveToSubmitted(job.id);
  await ed.dispose();
  const gallery = await api.addLink(job.id, "gallery", `https://example.com/gallery/${uniq("g").replace(/\s/g, "-")}`, "Gallery");
  await api.action(job.id, "approve");
  await api.transition(job.id, "delivered", { delivery: { shareJob: true } });
  return { job, editor, gallery };
}

const portalIds = async (session: Api) => (await session.portalJobs()).map((j) => j.id);

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("a client signs in to /portal; staff pages redirect there and staff APIs refuse them", async ({ api, pageWithState }) => {
  const c = await portalClient(api, "Routing");
  const job = await api.createJob({ name: uniq("Portal routing"), projectId: c.projectId });
  await api.shareJob(job.id);

  // Login: the API says where to go (a client's `next` outside /portal is ignored)…
  const login = await c.session.ctx.post("/api/auth/login", {
    data: { email: c.user.email, password: c.user.tempPassword, next: "/dashboard" },
    headers: { Origin: BASE_URL },
  });
  expect(login.status()).toBe(200);
  expect((await login.json()).data.redirectTo).toBe("/portal");

  // …and the form lands there.
  const page = await pageWithState(undefined);
  await signIn(page, c.user.email, c.user.tempPassword);
  await expect(page).toHaveURL(/\/portal(\?|$)/);
  await expect(page.getByRole("heading", { name: "Your work" })).toBeVisible();
  await expect(page.getByRole("banner")).toContainText(c.clientName);
  await expect(page.getByRole("main")).toContainText(job.name);

  for (const path of ["/dashboard", "/workspace/all", "/workspace/kanban", `/jobs/${job.id}`, "/jobs/new", "/settings/users", "/insights/analytics", "/team/workloads", "/activity", "/clients"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page, path).toHaveURL(/\/portal(\?|\/|$)/);
  }

  // /api/auth/me: the client-safe shape, nothing else.
  const me = await c.session.clientMe();
  expect(Object.keys(me).sort()).toEqual(["clientName", "email", "kind", "name", "studioName", "unreadCount"]);
  expect(me.kind).toBe("client");
  expect(me.clientName).toBe(c.clientName);

  // Every staff API is closed: 403 from the staff gate (never data, never a 200).
  for (const url of [
    "/api/jobs",
    `/api/jobs/${job.id}`,
    `/api/jobs/${job.id}/history`,
    `/api/jobs/${job.id}/comments`,
    `/api/jobs/${job.id}/notes`,
    "/api/kanban",
    "/api/dashboard",
    "/api/activity",
    "/api/search?q=portal",
    "/api/users",
    "/api/users/options",
    "/api/clients",
    "/api/clients/options",
    "/api/projects",
    "/api/workloads",
    "/api/analytics/overview",
    "/api/team-work",
    "/api/notifications",
    "/api/settings",
    "/api/system/integrity",
    "/api/me/work",
  ]) {
    const res = await c.session.raw("GET", url);
    expect([403, 404], `${url} → ${res.status}`).toContain(res.status);
  }
  for (const [url, body] of [
    ["/api/jobs", { name: "E2E client job", projectId: c.projectId }],
    [`/api/jobs/${job.id}/comments`, { body: "E2E client staff comment", mentionUserIds: [] }],
    [`/api/jobs/${job.id}/share`, { shared: false, expectedVersion: 1 }],
    ["/api/clients", { name: "E2E client creates client" }],
  ] as const) {
    const res = await c.session.raw("POST", url, body);
    expect([403, 404], `POST ${url} → ${res.status}`).toContain(res.status);
  }
  await c.session.dispose();
});

test("the client sees only shared jobs, with milestones; links only once delivered; delivery notes; nothing internal", async ({ api }) => {
  const c = await portalClient(api, "Shared");
  const editor = await api.inviteUser("editor", "Portal shared");
  const stamp = Date.now().toString(36);
  const job = await api.createJob({ name: uniq("Portal shared"), projectId: c.projectId, editorId: editor.user.id, shootDate: civilDate(-2), deliveryDueDate: civilDate(5) });
  const unshared = await api.createJob({ name: uniq("Portal unshared"), projectId: c.projectId });

  // Nothing is visible until the studio shares it.
  expect(await portalIds(c.session)).toEqual([]);
  expect((await c.session.raw("GET", `/api/portal/jobs/${job.id}`)).status).toBe(404);

  await api.shareJob(job.id);
  expect(await portalIds(c.session)).toEqual([job.id]);
  let detail = await c.session.portalJob(job.id);
  // A whitelist projection: exactly these keys (§7.4).
  expect(Object.keys(detail).sort()).toEqual([...PORTAL_JOB_DETAIL_KEYS].sort());
  expect(detail.milestone).toBe("shot");
  expect(detail.cancelled).toBe(false);
  expect(detail.deliveryDueDate).toBeTruthy();
  expect(detail.links).toEqual([]);
  expect(detail.canGiveFeedback).toBe(true);
  expect(detail.photographer?.name).toBeTruthy();

  // Internal material on the same job: never in the portal.
  const internalNote = `E2E INTERNAL NOTE ${stamp}`;
  const staffComment = `E2E STAFF COMMENT ${stamp}`;
  await api.addNote(job.id, "internal", internalNote);
  await api.addNote(job.id, "client", `E2E CLIENT-ABOUT NOTE ${stamp}`);
  await api.addComment(job.id, staffComment);

  // Editing: the editor's raw and finished links are not published by themselves.
  const ed = await loginApi(editor.email, editor.tempPassword);
  await ed.action(job.id, "accept");
  await ed.action(job.id, "start");
  expect((await c.session.portalJob(job.id)).milestone).toBe("editing");
  const finished = await ed.addLink(job.id, "finished_files", `https://example.com/finished/${stamp}`, "Finished");
  await ed.action(job.id, "submit");
  await ed.dispose();
  detail = await c.session.portalJob(job.id);
  expect(detail.milestone).toBe("editing");
  expect(detail.links).toEqual([]);

  // Review and deliver: the reviewer's gallery link is the default delivery set (§7.3).
  const gallery = await api.addLink(job.id, "gallery", `https://example.com/gallery/${stamp}`, "Gallery");
  await api.action(job.id, "approve");
  expect((await c.session.portalJob(job.id)).links).toEqual([]);
  const deliveryNote = `Your photos are ready — enjoy! ${stamp}`;
  await api.addNote(job.id, "delivery", deliveryNote);
  await api.transition(job.id, "delivered", { delivery: {} });

  detail = await c.session.portalJob(job.id);
  expect(detail.milestone).toBe("delivered");
  expect(detail.milestoneLabel).toBe("Delivered");
  expect(detail.deliveredAt).toBeTruthy();
  expect(detail.links.map((l) => l.id)).toEqual([gallery.id]);
  expect(detail.links.map((l) => l.url)).not.toContain(finished.url);
  expect(detail.deliveryNotes.map((n) => n.body)).toContain(deliveryNote);

  const text = JSON.stringify(detail);
  for (const secret of [internalNote, staffComment, `E2E CLIENT-ABOUT NOTE ${stamp}`, editor.user.name, editor.email, "E2E Portal Contact"]) {
    expect(text, secret).not.toContain(secret);
  }
  for (const key of ["status", "statusCategory", "priority", "dueDate", "reviewDueDate", "editor", "revisions", "revisionCount"]) {
    expect(Object.keys(detail), key).not.toContain(key);
  }

  // An explicitly shared link appears too; the unshared job stays a 404.
  await api.shareLink(finished.id);
  expect((await c.session.portalJob(job.id)).links.map((l) => l.id).sort()).toEqual([gallery.id, finished.id].sort());
  expect((await c.session.raw("GET", `/api/portal/jobs/${unshared.id}`)).status).toBe(404);
  expect(await portalIds(c.session)).not.toContain(unshared.id);

  // Reopening keeps the delivered work available ("Updating your delivery").
  await api.action(job.id, "complete");
  await api.reopen(job.id, "E2E: one more crop", "in_progress");
  detail = await c.session.portalJob(job.id);
  expect(detail.milestone).toBe("delivered");
  expect(detail.updating).toBe(true);
  expect(detail.links.map((l) => l.id)).toContain(gallery.id);
  await c.session.dispose();
});

test("sharing a project shares its current and future jobs; unsharing hides them again", async ({ api }) => {
  const c = await portalClient(api, "Project share");
  const project = await api.post<{ id: string }>("/api/projects", { clientId: c.clientId, name: uniq("E2E Portal shared project") });
  const before = await api.createJob({ name: uniq("Portal project before"), projectId: project.id, shootDate: civilDate(10) });

  await api.shareProject(project.id);
  const after = await api.createJob({ name: uniq("Portal project after"), projectId: project.id });
  expect((await portalIds(c.session)).sort()).toEqual([before.id, after.id].sort());
  const booked = await c.session.portalJob(before.id);
  expect(booked.milestone).toBe("booked");
  expect(booked.milestoneLabel).toBe("Booked");

  // An individually shared job stays visible when the project share is withdrawn.
  await api.shareJob(after.id);
  await api.shareProject(project.id, false);
  expect(await portalIds(c.session)).toEqual([after.id]);
  expect((await c.session.raw("GET", `/api/portal/jobs/${before.id}`)).status).toBe(404);
  await c.session.dispose();
});

test("Deliver dialog: with only finished files it pre-selects them, and the client then sees the link", async ({ page, api }) => {
  const c = await portalClient(api, "Deliver dialog");
  const editor = await api.inviteUser("editor", "Portal dialog");
  const job = await api.createJob({ name: uniq("Portal dialog"), projectId: c.projectId, editorId: editor.user.id });
  await api.shareJob(job.id);
  const ed = await loginApi(editor.email, editor.tempPassword);
  await ed.action(job.id, "accept");
  await ed.action(job.id, "start");
  const finishedUrl = `https://example.com/finished-only/${Date.now().toString(36)}`;
  const finished = await ed.addLink(job.id, "finished_files", finishedUrl, "Finished");
  await ed.action(job.id, "submit");
  await ed.dispose();
  await api.action(job.id, "approve");

  await page.goto(`/jobs/${job.id}`);
  await expect(jobHeading(page)).toBeVisible();
  const dialog = page.getByRole("dialog");
  await retrying(async () => {
    if (!(await dialog.isVisible())) await page.getByRole("button", { name: /^Deliver/ }).first().click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 3_000 });
  });
  await expect(dialog).toContainText(finishedUrl);
  await expect(dialog.getByRole("checkbox", { checked: true }).first()).toBeVisible();
  await dialog.getByRole("button", { name: /^Deliver/ }).last().click();
  await api.waitForCategory(job.id, "delivered");

  const detail = await c.session.portalJob(job.id);
  expect(detail.links.map((l) => l.id)).toEqual([finished.id]);
  await c.session.dispose();
});

test("feedback round trip: the client asks, the studio replies, the client follows up", async ({ api, pageWithState }) => {
  const c = await portalClient(api, "Feedback");
  const { job, editor } = await deliveredSharedJob(api, c.projectId, "Feedback");
  const owner = await api.me();
  const stamp = Date.now().toString(36);
  const question = `Could photo 3 be a little brighter? ${stamp}`;

  const root = await c.session.postFeedback(job.id, question);
  // Staff see it as a client_feedback thread started by the client user.
  const thread = await eventually(async () => (await api.comments(job.id)).find((n) => n.id === root.id));
  expect(thread.kind).toBe("client_feedback");
  expect(thread.author.id).toBe(c.user.user.id);

  // The owner (photographer ∪ creator ∪ admin) gets exactly one client_feedback notification.
  const ownerNotes = await eventually(async () => {
    const list = (await api.notifications()).items.filter((n) => n.type === "client_feedback" && n.job?.id === job.id);
    return list.length ? list : null;
  });
  expect(ownerNotes).toHaveLength(1);
  // Editors read client feedback but are neither notified nor allowed to reply.
  const ed = await loginApi(editor.email, editor.tempPassword);
  expect((await ed.notifications()).items.filter((n) => n.type === "client_feedback")).toHaveLength(0);
  expect((await ed.comments(job.id)).map((n) => n.id)).toContain(root.id);
  expect((await ed.raw("POST", `/api/jobs/${job.id}/comments`, { body: "E2E editor reply", kind: "client_feedback", parentCommentId: root.id, mentionUserIds: [] })).status).toBe(403);
  await ed.dispose();

  // Staff cannot start a client thread, @mention in one, or slip an internal reply into it.
  expect([403, 422]).toContain((await api.raw("POST", `/api/jobs/${job.id}/comments`, { body: "E2E staff root", kind: "client_feedback", mentionUserIds: [] })).status);
  expect(
    (await api.raw("POST", `/api/jobs/${job.id}/comments`, { body: "E2E mention", kind: "client_feedback", parentCommentId: root.id, mentionUserIds: [editor.user.id] })).status,
  ).toBe(422);
  expect([400, 422]).toContain((await api.raw("POST", `/api/jobs/${job.id}/comments`, { body: "E2E internal reply", kind: "comment", parentCommentId: root.id, mentionUserIds: [] })).status);

  const answer = `Yes — a brighter version is on its way. ${stamp}`;
  await api.addComment(job.id, answer, { kind: "client_feedback", parentCommentId: root.id });

  const detail = await c.session.portalJob(job.id);
  const t = detail.feedback.find((f) => f.id === root.id);
  expect(t?.isClient).toBe(true);
  expect(t?.body).toBe(question);
  expect(t?.replies.map((r) => [r.body, r.isClient, r.authorName])).toEqual([[answer, false, owner.user.name]]);
  const replyNote = await eventually(async () => (await c.session.portalNotifications()).items.find((n) => n.type === "client_feedback_reply" && n.linkPath.includes(job.id)));
  expect(replyNote.linkPath).toContain(`/portal/jobs/${job.id}`);

  // The client edits their own message; a studio reply is not theirs to touch (404).
  const replyId = t?.replies[0]?.id ?? "";
  expect((await c.session.raw("PATCH", `/api/portal/comments/${root.id}`, { body: `${question} (edited)` })).status).toBe(200);
  expect((await c.session.raw("PATCH", `/api/portal/comments/${replyId}`, { body: "E2E hijack" })).status).toBe(404);
  expect((await c.session.raw("DELETE", `/api/portal/comments/${replyId}`)).status).toBe(404);

  // UI: the client follows up from the job page; links open safely in a new tab.
  const page = await pageWithState(undefined);
  await signIn(page, c.user.email, c.user.tempPassword);
  await expect(page).toHaveURL(/\/portal/);
  await gotoReady(page, `/portal/jobs/${job.id}`, page.getByText(answer).first());
  const link = page.locator('main a[href^="https://example.com/gallery/"]').first();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(link).toHaveAttribute("rel", /noreferrer/);
  const followUp = `Thanks! One more: can photo 5 be cropped square? ${stamp}`;
  const composer = page.getByRole("textbox", { name: /feedback|message|reply/i }).first();
  await composer.fill(followUp);
  await page.getByRole("button", { name: /^(Send|Post|Reply)/ }).first().click();
  await expect(page.getByText(followUp).first()).toBeVisible();
  const staffView = await eventually(async () => {
    const node = (await api.comments(job.id)).find((n) => n.id === root.id);
    return node && node.replies.some((r) => r.body === followUp) ? node : null;
  });
  expect(staffView.replies.map((r) => r.author.id)).toContain(c.user.user.id);
  await c.session.dispose();
});

test("feedback switched off: the job is visible but the client cannot post", async ({ api }) => {
  const c = await portalClient(api, "No feedback", { feedback: false });
  const job = await api.createJob({ name: uniq("Portal no feedback"), projectId: c.projectId });
  await api.shareJob(job.id);
  const detail = await c.session.portalJob(job.id);
  expect(detail.canGiveFeedback).toBe(false);
  expect((await c.session.raw("POST", `/api/portal/jobs/${job.id}/feedback`, { body: "E2E not allowed" })).status).toBe(403);
  await c.session.dispose();
});

test("a cancelled shared job shows as Cancelled, without links or feedback", async ({ api }) => {
  const c = await portalClient(api, "Cancelled");
  const job = await api.createJob({ name: uniq("Portal cancelled"), projectId: c.projectId });
  await api.shareJob(job.id);
  const ref = await api.addLink(job.id, "reference", `https://example.com/floorplan/${Date.now().toString(36)}`, "Floor plan");
  await api.shareLink(ref.id);
  expect((await c.session.portalJob(job.id)).links.map((l) => l.id)).toEqual([ref.id]);

  await api.action(job.id, "cancel", { reason: "E2E: client postponed" });
  const detail = await c.session.portalJob(job.id);
  expect(detail.cancelled).toBe(true);
  expect(detail.milestone).toBeNull();
  expect(detail.milestoneLabel).toBe("Cancelled");
  expect(detail.cancelledAt).toBeTruthy();
  expect(detail.links).toEqual([]);
  expect(detail.canGiveFeedback).toBe(false);
  expect((await c.session.raw("POST", `/api/portal/jobs/${job.id}/feedback`, { body: "E2E after cancel" })).status).toBe(403);
  await c.session.dispose();
});

test("isolation: another client, another studio and staff sessions never reach a client's portal job", async ({ api, apiAs, page }) => {
  const a = await portalClient(api, "Iso A");
  const b = await portalClient(api, "Iso B");
  const aJob = await api.createJob({ name: uniq("Portal iso A"), projectId: a.projectId });
  const bJob = await api.createJob({ name: uniq("Portal iso B"), projectId: b.projectId });
  await api.shareJob(aJob.id);
  await api.shareJob(bJob.id);
  const aRoot = await a.session.postFeedback(aJob.id, "E2E A's feedback");

  expect(await portalIds(a.session)).toEqual([aJob.id]);
  expect(await portalIds(b.session)).toEqual([bJob.id]);
  expect((await a.session.raw("GET", `/api/portal/jobs/${bJob.id}`)).status).toBe(404);
  expect((await b.session.raw("GET", `/api/portal/jobs/${aJob.id}`)).status).toBe(404);
  expect((await b.session.raw("POST", `/api/portal/jobs/${aJob.id}/feedback`, { body: "E2E intruder" })).status).toBe(404);
  expect((await b.session.raw("PATCH", `/api/portal/comments/${aRoot.id}`, { body: "E2E intruder edit" })).status).toBe(404);
  expect((await b.session.raw("DELETE", `/api/portal/comments/${aRoot.id}`)).status).toBe(404);

  // The other studio's client user: 404 for every Northlight id, portal or staff.
  const otherClient = await apiAs("other-client");
  for (const url of [`/api/portal/jobs/${aJob.id}`, `/api/portal/jobs/${bJob.id}`]) expect((await otherClient.raw("GET", url)).status, url).toBe(404);
  expect(await portalIds(otherClient)).not.toContain(aJob.id);
  expect([403, 404]).toContain((await otherClient.raw("GET", `/api/jobs/${aJob.id}`)).status);

  // Staff never use the portal: its API refuses them and its pages send them to the dashboard.
  for (const role of ["owner", "editor"] as const) {
    const staff = await apiAs(role);
    expect((await staff.raw("GET", "/api/portal/jobs")).status, role).toBe(403);
    expect((await staff.raw("GET", `/api/portal/jobs/${aJob.id}`)).status, role).toBe(403);
  }
  await page.goto("/portal", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/dashboard/);

  // Client users never appear in staff people lists for non-admins.
  const member = await apiAs("photographer-noflags");
  expect(JSON.stringify(await member.get<unknown>("/api/users"))).not.toContain(a.user.email);
  expect([403, 404]).toContain((await member.raw("GET", `/api/users/${a.user.user.id}`)).status);
  expect((await member.raw("GET", "/api/users?role=client")).status).toBe(400);

  await a.session.dispose();
  await b.session.dispose();
});

test("turning the portal off signs the client out; their login then fails like a wrong password", async ({ api }) => {
  const c = await portalClient(api, "Portal off");
  expect((await c.session.raw("GET", "/api/auth/me")).status).toBe(200);
  await api.setClientPortal(c.clientId, { portalEnabled: false });

  const me = await c.session.raw("GET", "/api/auth/me");
  expect(me.status).toBe(401);
  expect(me.error?.code).toBe("unauthorized");
  const relogin = await c.session.ctx.post("/api/auth/login", { data: { email: c.user.email, password: c.user.tempPassword }, headers: { Origin: BASE_URL } });
  const wrong = await c.session.ctx.post("/api/auth/login", { data: { email: c.user.email, password: "definitely-wrong-1" }, headers: { Origin: BASE_URL } });
  expect(relogin.status()).toBe(401);
  expect(wrong.status()).toBe(401);
  // No credential-validity oracle: the same error for both.
  expect((await relogin.json()).error).toEqual((await wrong.json()).error);
  await c.session.dispose();
});

test.describe("seeded portal users", () => {
  test("Harbourline's client sees the studio and client names and their shared work", async ({ pageAs, apiAs }) => {
    const page = await pageAs("client");
    await gotoReady(page, "/portal", page.getByRole("heading", { name: "Your work" }));
    await expect(page.getByRole("banner")).toContainText("Harbourline Realty");
    await expect(page.getByRole("banner")).toContainText("Northlight Studios");
    const client = await apiAs("client");
    const jobs = await client.portalJobs();
    expect(jobs.length).toBeGreaterThan(0);
    const first = jobs[0];
    await page.goto(`/portal/jobs/${first.id}`);
    await expect(page.getByRole("main")).toContainText(first.name);
    // The other studio's client cannot open it.
    const other = await apiAs("other-client");
    expect((await other.raw("GET", `/api/portal/jobs/${first.id}`)).status).toBe(404);
    // Nor can a client of another Northlight client.
    const client2 = await apiAs("client2");
    expect((await client2.raw("GET", `/api/portal/jobs/${first.id}`)).status).toBe(404);
  });

  test("Coastal Key's client has nothing shared and sees the empty state", async ({ pageAs, apiAs }) => {
    const client2 = await apiAs("client2");
    expect(await client2.portalJobs()).toEqual([]);
    const page = await pageAs("client2");
    await gotoReady(page, "/portal", page.getByRole("heading", { name: "Your work" }));
    await expect(page.getByRole("main")).toContainText("Nothing has been shared with you yet. Your studio will let you know.");
  });

  test("the portal job page lists milestones in order", async ({ pageAs, apiAs }) => {
    const client = await apiAs("client");
    const delivered = (await client.portalJobs()).find((j) => j.milestone === "delivered");
    test.skip(!delivered, "seed has no delivered Harbourline job");
    const page = await pageAs("client");
    await gotoReady(page, `/portal/jobs/${delivered!.id}`, page.getByRole("main").getByText(delivered!.name));
    const main = page.getByRole("main");
    const text = (await main.innerText()).replace(/\s+/g, " ");
    const order = ["Booked", "Shot", "Editing", "Delivered"].map((l) => text.search(new RegExp(`\\b${escapeRegExp(l)}\\b`)));
    expect(order.every((i) => i >= 0), `milestones in ${text.slice(0, 300)}`).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
});
