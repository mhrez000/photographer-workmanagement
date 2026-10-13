import type { Page } from "@playwright/test";
import { BASE_URL, PORTAL_JOB_DETAIL_KEYS, civilDate, escapeRegExp, eventually, loginApi, uniq, uniqUrl, type Api, type InvitedUser } from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, retrying, sectionNamed, test } from "./fixtures";

/**
 * Client portal (docs/ROLES.md §7; docs/SIMPLIFICATION-PLAN.md §3 "Client (portal): Unchanged", §4
 * "What the client sees", §5 Approve). A client user sees, at /portal only, the jobs the studio shared
 * with their client: Booked → Shot → Editing → Delivered, the links the studio shared at delivery,
 * delivery notes and their own feedback. Never editors, stages, internal notes or staff messages.
 * "Approve & send" shares the finished photos; "Approve only" leaves "Not sent to client".
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

interface PortalClient {
  clientId: string;
  clientName: string;
  user: InvitedUser;
  session: Api;
}

async function portalClient(api: Api, label: string, opts: { feedback?: boolean } = {}): Promise<PortalClient> {
  const { clientId, clientName } = await api.createClient(`Portal ${label}`, {
    portal: true,
    feedback: opts.feedback ?? true,
    contact: { contactName: "E2E Portal Contact", email: `e2e-portal-contact-${Date.now().toString(36)}@example.com` },
  });
  const user = await api.inviteUser("client", { label: `Portal ${label}`, clientId });
  const session = await loginApi(user.email, user.tempPassword);
  return { clientId, clientName, user, session };
}

/** A shared job the editor sent for checking and the owner approved with "Approve & send". */
async function deliveredSharedJob(api: Api, clientId: string, label: string) {
  const editor = await api.inviteUser("editor", `Portal ${label}`);
  const job = await api.createJob({ name: uniq(`Portal ${label}`), clientId, editorId: editor.user.id, shootDate: civilDate(-3), deliveryDueDate: civilDate(2) });
  const ed = await loginApi(editor.email, editor.tempPassword);
  const finished = uniqUrl("finished");
  await ed.sendForChecking(job.id, finished);
  await ed.dispose();
  await api.approve(job.id, "send");
  return { job, editor, finished };
}

const portalIds = async (session: Api) => (await session.portalJobs()).map((j) => j.id);

/** Signs the client in through the form and waits until the portal has opened (a pre-hydration press is a no-op in `next dev`). */
async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await retrying(async () => {
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
  });
}

test("a client signs in to /portal; staff pages redirect there and staff APIs refuse them", async ({ api, pageWithState }) => {
  const c = await portalClient(api, "Routing");
  const job = await api.createJob({ name: uniq("Portal routing"), clientId: c.clientId });
  await api.shareJob(job.id);

  const login = await c.session.ctx.post("/api/auth/login", {
    data: { email: c.user.email, password: c.user.tempPassword, next: "/home" },
    headers: { Origin: BASE_URL },
  });
  expect(login.status()).toBe(200);
  expect((await login.json()).data.redirectTo).toBe("/portal");

  const page = await pageWithState(undefined);
  await signIn(page, c.user.email, c.user.tempPassword);
  await expect(page).toHaveURL(/\/portal(\?|$)/);
  await expect(page.getByRole("heading", { name: "Your work" })).toBeVisible();
  await expect(page.getByRole("banner")).toContainText(c.clientName);
  await expect(page.getByRole("main")).toContainText(job.name);

  for (const path of ["/home", "/jobs", "/my-jobs", `/jobs/${job.id}`, "/jobs/new", "/settings/people", "/editors", "/clients", "/dashboard", "/workspace/all"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page, path).toHaveURL(/\/portal(\?|\/|$)/);
  }

  const me = await c.session.clientMe();
  expect(Object.keys(me).sort()).toEqual(["clientName", "email", "kind", "name", "studioName", "unreadCount"]);
  expect(me.kind).toBe("client");

  for (const url of ["/api/jobs", `/api/jobs/${job.id}`, `/api/jobs/${job.id}/history`, `/api/jobs/${job.id}/comments`, `/api/jobs/${job.id}/notes`, "/api/activity", "/api/search?q=portal", "/api/users", "/api/clients", "/api/notifications", "/api/settings", "/api/system/integrity"]) {
    const res = await c.session.raw("GET", url);
    expect([403, 404], `${url} → ${res.status}`).toContain(res.status);
  }
  for (const [url, body] of [
    ["/api/jobs", { name: "E2E client job", autoProject: { clientId: c.clientId, address: "1 Client St" } }],
    [`/api/jobs/${job.id}/comments`, { body: "E2E client staff comment", mentionUserIds: [] }],
    [`/api/jobs/${job.id}/share`, { shared: false, expectedVersion: 1 }],
    ["/api/clients", { name: "E2E client creates client" }],
  ] as const) {
    const res = await c.session.raw("POST", url, body);
    expect([403, 404], `POST ${url} → ${res.status}`).toContain(res.status);
  }
  await c.session.dispose();
});

test("the client sees Booked → Shot → Editing → Delivered; links only once sent; never editors, stages or internal notes", async ({ api }) => {
  const c = await portalClient(api, "Shared");
  const editor = await api.inviteUser("editor", "Portal shared");
  const stamp = Date.now().toString(36);
  const job = await api.createJob({ name: uniq("Portal shared"), clientId: c.clientId, editorId: editor.user.id, shootDate: civilDate(-2), deliveryDueDate: civilDate(5) });
  const unshared = await api.createJob({ name: uniq("Portal unshared"), clientId: c.clientId });

  expect(await portalIds(c.session)).toEqual([]);
  expect((await c.session.raw("GET", `/api/portal/jobs/${job.id}`)).status).toBe(404);

  await api.shareJob(job.id);
  expect(await portalIds(c.session)).toEqual([job.id]);
  let detail = await c.session.portalJob(job.id);
  expect(Object.keys(detail).sort()).toEqual([...PORTAL_JOB_DETAIL_KEYS].sort());
  expect(detail.milestone).toBe("shot"); // With editor before work starts = Shot
  expect(detail.links).toEqual([]);
  expect(detail.canGiveFeedback).toBe(true);

  const internalNote = `E2E INTERNAL NOTE ${stamp}`;
  const staffMessage = `E2E STAFF MESSAGE ${stamp}`;
  await api.addNote(job.id, "internal", internalNote);
  await api.addComment(job.id, staffMessage);

  const ed = await loginApi(editor.email, editor.tempPassword);
  await ed.startEditing(job.id);
  expect((await c.session.portalJob(job.id)).milestone).toBe("editing");
  const finishedUrl = uniqUrl("finished");
  await ed.sendForChecking(job.id, finishedUrl);
  await ed.dispose();
  expect((await c.session.portalJob(job.id)).milestone).toBe("editing"); // Ready to check = Editing
  expect((await c.session.portalJob(job.id)).links).toEqual([]);
  await api.askForChanges(job.id, "Warmer hero", ["Colour"]);
  expect((await c.session.portalJob(job.id)).milestone).toBe("editing"); // Changes asked = Editing
  const ed2 = await loginApi(editor.email, editor.tempPassword);
  await ed2.sendForChecking(job.id, finishedUrl);
  await ed2.dispose();

  // Approve & send: Delivered, with the finished photos shared.
  const deliveryNote = `Your photos are ready — enjoy! ${stamp}`;
  await api.addNote(job.id, "delivery", deliveryNote);
  await api.approve(job.id, "send");
  detail = await c.session.portalJob(job.id);
  expect(detail.milestone).toBe("delivered");
  expect(detail.milestoneLabel).toBe("Delivered");
  expect(detail.deliveredAt).toBeTruthy();
  expect(detail.links.map((l) => l.url)).toContain(finishedUrl);
  expect(detail.deliveryNotes.map((n) => n.body)).toContain(deliveryNote);

  const text = JSON.stringify(detail);
  for (const secret of [internalNote, staffMessage, editor.user.name, editor.email, "E2E Portal Contact", "Ready to check", "Changes asked", "Round"]) {
    expect(text, secret).not.toContain(secret);
  }
  for (const key of ["status", "statusCategory", "priority", "dueDate", "reviewDueDate", "editor", "revisions", "revisionCount", "stage"]) {
    expect(Object.keys(detail), key).not.toContain(key);
  }
  expect((await c.session.raw("GET", `/api/portal/jobs/${unshared.id}`)).status).toBe(404);
  await c.session.dispose();
});

test("Approve only leaves the job Done · Not sent to client; Send to client shares it afterwards", async ({ api }) => {
  const c = await portalClient(api, "Approve only");
  const editor = await api.inviteUser("editor", "Portal approve only");
  const job = await api.createJob({ name: uniq("Portal approve only"), clientId: c.clientId, editorId: editor.user.id });
  await api.shareJob(job.id);
  const ed = await loginApi(editor.email, editor.tempPassword);
  const finished = uniqUrl("finished");
  await ed.sendForChecking(job.id, finished);
  await ed.dispose();

  const only = await api.approve(job.id, "only");
  expect(only.job.statusCategory).toBe("approved"); // Done · Not sent to client
  let detail = await c.session.portalJob(job.id);
  expect(detail.milestone).toBe("editing");
  expect(detail.links).toEqual([]);

  // Send to client = the recorded delivery step, sharing the finished link.
  await api.sendToClient(job.id);
  detail = await c.session.portalJob(job.id);
  expect(detail.milestone).toBe("delivered");
  expect(detail.links.map((l) => l.url)).toContain(finished);
  await c.session.dispose();
});

test("a client of a studio without the portal is never asked about: Approve finishes straight away", async ({ api }) => {
  const { clientId } = await api.createClient("No portal");
  const editor = await api.inviteUser("editor", "No portal");
  const job = await api.createJob({ name: uniq("No portal approve"), clientId, editorId: editor.user.id });
  const ed = await loginApi(editor.email, editor.tempPassword);
  await ed.sendForChecking(job.id);
  await ed.dispose();
  const done = await api.approve(job.id, "n/a");
  expect(done.job.statusCategory).toBe("completed");
  expect(done.job.sharedWithClient ?? false).toBe(false);
});

test("feedback round trip: the client asks, the studio replies from 'From the client', the client follows up", async ({ page, api, pageWithState }) => {
  const c = await portalClient(api, "Feedback");
  const { job, editor } = await deliveredSharedJob(api, c.clientId, "Feedback");
  const owner = await api.me();
  const stamp = Date.now().toString(36);
  const question = `Could photo 3 be a little brighter? ${stamp}`;

  const root = await c.session.postFeedback(job.id, question);
  const thread = await eventually(async () => (await api.comments(job.id)).find((n) => n.id === root.id));
  expect(thread.kind).toBe("client_feedback");

  // The owner gets one client_feedback notification (default-on group 6) and sees it on Home.
  const ownerNotes = await eventually(async () => {
    const list = (await api.notifications()).items.filter((n) => n.type === "client_feedback" && n.job?.id === job.id);
    return list.length ? list : null;
  });
  expect(ownerNotes).toHaveLength(1);
  await gotoReady(page, "/home", sectionNamed(page, /^needs attention/i));
  await expect(sectionNamed(page, /^needs attention/i).getByRole("listitem").filter({ hasText: job.name }).first()).toContainText(/message from the client/i);

  // Editors are neither notified nor allowed to reply.
  const ed = await loginApi(editor.email, editor.tempPassword);
  expect((await ed.notifications()).items.filter((n) => n.type === "client_feedback")).toHaveLength(0);
  expect((await ed.raw("POST", `/api/jobs/${job.id}/comments`, { body: "E2E editor reply", kind: "client_feedback", parentCommentId: root.id, mentionUserIds: [] })).status).toBe(403);
  await ed.dispose();

  // The owner replies from the "From the client" section of the job page.
  await gotoReady(page, `/jobs/${job.id}`, page.getByRole("main").getByText(question));
  // The card is titled "From <client name>".
  const fromClient = sectionNamed(page, new RegExp(`^From ${c.clientName}`));
  await expect(fromClient).toContainText(question);
  const answer = `Yes — a brighter version is on its way. ${stamp}`;
  await fromClient.getByRole("button", { name: /reply to client/i }).first().click();
  const box = fromClient.getByRole("textbox", { name: /reply to client/i });
  await box.fill(answer);
  await fromClient.getByRole("button", { name: /^(send|reply|post)/i }).first().click();
  await eventually(async () => (await api.comments(job.id)).find((n) => n.id === root.id)?.replies.some((r) => r.body === answer));

  const detail = await c.session.portalJob(job.id);
  const t = detail.feedback.find((f) => f.id === root.id);
  expect(t?.replies.map((r) => [r.body, r.isClient, r.authorName])).toEqual([[answer, false, owner.user.name]]);
  const replyNote = await eventually(async () => (await c.session.portalNotifications()).items.find((n) => n.type === "client_feedback_reply" && n.linkPath.includes(job.id)));
  expect(replyNote.linkPath).toContain(`/portal/jobs/${job.id}`);

  // The client follows up from the portal.
  const cp = await pageWithState(undefined);
  await signIn(cp, c.user.email, c.user.tempPassword);
  await gotoReady(cp, `/portal/jobs/${job.id}`, cp.getByText(answer).first());
  const followUp = `Thanks! One more: can photo 5 be cropped square? ${stamp}`;
  await cp.getByRole("textbox", { name: /feedback|message|reply/i }).first().fill(followUp);
  await cp.getByRole("button", { name: /^(Send|Post|Reply)/ }).first().click();
  await expect(cp.getByText(followUp).first()).toBeVisible();
  await eventually(async () => (await api.comments(job.id)).find((n) => n.id === root.id)?.replies.some((r) => r.body === followUp));
  await c.session.dispose();
});

test("feedback switched off: the job is visible but the client cannot post", async ({ api }) => {
  const c = await portalClient(api, "No feedback", { feedback: false });
  const job = await api.createJob({ name: uniq("Portal no feedback"), clientId: c.clientId });
  await api.shareJob(job.id);
  expect((await c.session.portalJob(job.id)).canGiveFeedback).toBe(false);
  expect((await c.session.raw("POST", `/api/portal/jobs/${job.id}/feedback`, { body: "E2E not allowed" })).status).toBe(403);
  await c.session.dispose();
});

test("a cancelled shared job shows as Cancelled, without links or feedback", async ({ api }) => {
  const c = await portalClient(api, "Cancelled");
  const job = await api.createJob({ name: uniq("Portal cancelled"), clientId: c.clientId });
  await api.shareJob(job.id);
  await api.action(job.id, "cancel", { reason: "E2E: client postponed" });
  const detail = await c.session.portalJob(job.id);
  expect(detail.cancelled).toBe(true);
  expect(detail.milestone).toBeNull();
  expect(detail.milestoneLabel).toBe("Cancelled");
  expect(detail.links).toEqual([]);
  expect(detail.canGiveFeedback).toBe(false);
  await c.session.dispose();
});

test("isolation: another client, another studio and staff sessions never reach a client's portal job", async ({ api, apiAs, page }) => {
  const a = await portalClient(api, "Iso A");
  const b = await portalClient(api, "Iso B");
  const aJob = await api.createJob({ name: uniq("Portal iso A"), clientId: a.clientId });
  const bJob = await api.createJob({ name: uniq("Portal iso B"), clientId: b.clientId });
  await api.shareJob(aJob.id);
  await api.shareJob(bJob.id);
  const aRoot = await a.session.postFeedback(aJob.id, "E2E A's feedback");

  expect(await portalIds(a.session)).toEqual([aJob.id]);
  expect(await portalIds(b.session)).toEqual([bJob.id]);
  expect((await a.session.raw("GET", `/api/portal/jobs/${bJob.id}`)).status).toBe(404);
  expect((await b.session.raw("POST", `/api/portal/jobs/${aJob.id}/feedback`, { body: "E2E intruder" })).status).toBe(404);
  expect((await b.session.raw("PATCH", `/api/portal/comments/${aRoot.id}`, { body: "E2E intruder edit" })).status).toBe(404);

  const otherClient = await apiAs("other-client");
  for (const url of [`/api/portal/jobs/${aJob.id}`, `/api/portal/jobs/${bJob.id}`]) expect((await otherClient.raw("GET", url)).status, url).toBe(404);

  for (const role of ["owner", "editor"] as const) {
    const staff = await apiAs(role);
    expect((await staff.raw("GET", "/api/portal/jobs")).status, role).toBe(403);
  }
  await page.goto("/portal", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/home/);

  // Client users never appear in staff people lists for non-admins.
  const member = await apiAs("photographer");
  expect(JSON.stringify(await member.get<unknown>("/api/users"))).not.toContain(a.user.email);
  expect((await member.raw("GET", "/api/users?role=client")).status).toBe(400);
  await a.session.dispose();
  await b.session.dispose();
});

test("turning the portal off signs the client out; their login then fails like a wrong password", async ({ api }) => {
  const c = await portalClient(api, "Portal off");
  expect((await c.session.raw("GET", "/api/auth/me")).status).toBe(200);
  await api.setClientPortal(c.clientId, { portalEnabled: false });
  expect((await c.session.raw("GET", "/api/auth/me")).status).toBe(401);
  const relogin = await c.session.ctx.post("/api/auth/login", { data: { email: c.user.email, password: c.user.tempPassword }, headers: { Origin: BASE_URL } });
  const wrong = await c.session.ctx.post("/api/auth/login", { data: { email: c.user.email, password: "definitely-wrong-1" }, headers: { Origin: BASE_URL } });
  expect(relogin.status()).toBe(401);
  expect(wrong.status()).toBe(401);
  expect((await relogin.json()).error).toEqual((await wrong.json()).error);
  await c.session.dispose();
});

test.describe("seeded portal user", () => {
  test("Harbourline's client sees the studio and client names, their shared work, and milestones in order", async ({ pageAs, apiAs }) => {
    const page = await pageAs("client");
    await gotoReady(page, "/portal", page.getByRole("heading", { name: "Your work" }));
    await expect(page.getByRole("banner")).toContainText("Harbourline Realty");
    await expect(page.getByRole("banner")).toContainText("Northlight");
    const client = await apiAs("client");
    const jobs = await client.portalJobs();
    expect(jobs.length).toBeGreaterThan(0);
    const other = await apiAs("other-client");
    expect((await other.raw("GET", `/api/portal/jobs/${jobs[0].id}`)).status).toBe(404);

    const delivered = jobs.find((j) => j.milestone === "delivered");
    test.skip(!delivered, "seed has no delivered Harbourline job");
    await gotoReady(page, `/portal/jobs/${delivered!.id}`, page.getByRole("main").getByText(delivered!.name));
    const text = (await page.getByRole("main").innerText()).replace(/\s+/g, " ");
    const order = ["Booked", "Shot", "Editing", "Delivered"].map((l) => text.search(new RegExp(`\\b${escapeRegExp(l)}\\b`)));
    expect(order.every((i) => i >= 0), `milestones in ${text.slice(0, 300)}`).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // The client's words, never the staff's (plan §4): no "Done", no stage names.
    expect(text).not.toMatch(/Ready to check|Changes asked|With editor|Needs editor/);
  });
});

test("the portal keeps working with the new, simpler delivery: Copy link for a client without the portal is a staff-only thing", async ({ page, api, apiAs }) => {
  const { clientId } = await api.createClient("Copy link");
  const editor = await api.inviteUser("editor", "Copy link");
  const job = await api.createJob({ name: uniq("Copy link job"), clientId, editorId: editor.user.id });
  const ed = await loginApi(editor.email, editor.tempPassword);
  await ed.sendForChecking(job.id);
  await ed.dispose();
  await api.approve(job.id, "n/a");
  await gotoReady(page, `/jobs/${job.id}`, page.getByRole("main").getByRole("heading", { level: 1 }).first());
  await expect(page.getByRole("main").getByRole("button", { name: /copy (finished link|link to send the client)/i }).first()).toBeVisible();
  await retrying(async () => {
    await page.getByRole("main").getByRole("button", { name: /copy (finished link|link to send the client)/i }).first().click({ timeout: 5_000 });
    await expect(page.getByText(/copied/i).first()).toBeVisible({ timeout: 3_000 });
  });
  const otherClient = await apiAs("other-client");
  expect((await otherClient.raw("GET", `/api/portal/jobs/${job.id}`)).status).toBe(404);
});
