import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobComments, jobLinks, jobNotes, notifications, projects } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, setUserFlags, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { newId } from "@/lib/ids";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import {
  getClientPortalAccess,
  getClientPreview,
  getJobClientAccess,
  getPortalJob,
  getPortalProject,
  getProjectClientSharing,
  listPortalJobs,
  listPortalNotifications,
  listPortalProjectGroups,
  loadPortalJob,
  ownFeedbackIds,
  portalUnreadCount,
} from "./portal";

const NOW = "2026-10-08T00:00:00.000Z"; // 11:00 in Sydney
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * DAY).toISOString();

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const ctxOf = async (key: keyof SeedIds["users"]) => contextFor(db, ids.users[key]);
const job = async (opts: JobFixtureOptions = {}) => (await insertJobFixture(db, ids, { at: daysAgo(3), ...opts })).job;

async function addLink(jobId: string, opts: { kind?: "gallery" | "finished_files" | "raw_files" | "client_delivery"; shared?: boolean; url?: string; label?: string } = {}) {
  const id = newId();
  await db.insert(jobLinks).values({
    id,
    organisationId: ids.organisationId,
    jobId,
    kind: opts.kind ?? "gallery",
    url: opts.url ?? `https://example.com/${id}`,
    label: opts.label ?? null,
    provider: "other",
    addedByUserId: ids.users.owner,
    sharedWithClient: opts.shared ?? false,
    addedBySharer: true,
    createdAt: daysAgo(1),
  });
  return id;
}

async function addNote(jobId: string, kind: "delivery" | "internal" | "photographer", body: string, archived = false) {
  const id = newId();
  await db.insert(jobNotes).values({
    id,
    organisationId: ids.organisationId,
    jobId,
    kind,
    body,
    authorUserId: ids.users.owner,
    archivedAt: archived ? daysAgo(0) : null,
    archivedByUserId: archived ? ids.users.owner : null,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  });
  return id;
}

async function addComment(jobId: string, authorUserId: string, body: string, opts: { kind?: "client_feedback" | "comment"; parent?: string; at?: string } = {}) {
  const id = newId();
  let root: string = id;
  if (opts.parent) {
    const [p] = await db.select().from(jobComments).where(eq(jobComments.id, opts.parent));
    root = p?.rootCommentId ?? opts.parent;
  }
  await db.insert(jobComments).values({
    id,
    organisationId: ids.organisationId,
    jobId,
    parentCommentId: opts.parent ?? null,
    rootCommentId: root,
    authorUserId,
    kind: opts.kind ?? "client_feedback",
    body,
    createdAt: opts.at ?? daysAgo(1),
  });
  return id;
}

/* ------------------------------------------------------------------ */

describe("portal visibility (docs/ROLES.md §7.2)", () => {
  it("lists only the client's shared jobs (job share or project share)", async () => {
    const direct = await job({ name: "Direct share", sharedWithClient: true });
    const hidden = await job({ name: "Not shared" });
    const other = await job({ name: "Other client", projectId: ids.projectId2, sharedWithClient: true });
    const client = await ctxOf("client");

    expect((await listPortalJobs(db, client)).map((j) => j.id)).toEqual([direct.id]);

    await db.update(projects).set({ sharedWithClient: true }).where(eq(projects.id, ids.projectId));
    expect((await listPortalJobs(db, client)).map((j) => j.id).sort()).toEqual([direct.id, hidden.id].sort());

    // client2 sees only their own client's shared work.
    expect((await listPortalJobs(db, await ctxOf("client2"))).map((j) => j.id)).toEqual([other.id]);
  });

  it("404s (never 403) for unshared, other-client, foreign and unknown jobs", async () => {
    const unshared = await job();
    const otherClient = await job({ projectId: ids.projectId2, sharedWithClient: true });
    const client = await ctxOf("client");
    for (const id of [unshared.id, otherClient.id, "nope"]) {
      await expect(getPortalJob(db, client, id)).rejects.toBeInstanceOf(NotFoundError);
    }
    const otherOrg = await seedMinimalOrg(db, { slug: "other" });
    const foreign = (await insertJobFixture(db, otherOrg, { sharedWithClient: true, at: daysAgo(2) })).job;
    await expect(getPortalJob(db, client, foreign.id)).rejects.toBeInstanceOf(NotFoundError);
    // and the other org's client cannot see ours
    const shared = await job({ sharedWithClient: true });
    await expect(getPortalJob(db, await contextFor(db, otherOrg.users.client), shared.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("is client-only: staff contexts are refused", async () => {
    const shared = await job({ sharedWithClient: true });
    for (const key of ["owner", "photographer1", "editor1"] as const) {
      await expect(listPortalJobs(db, await ctxOf(key))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getPortalJob(db, await ctxOf(key), shared.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("shows a cancelled job for 30 days as Cancelled without links, then 404", async () => {
    const recent = await job({ statusKey: "cancelled", sharedWithClient: true, at: daysAgo(5) });
    await addLink(recent.id, { shared: true });
    const old = await job({ statusKey: "cancelled", sharedWithClient: true, at: daysAgo(31) });
    const client = await ctxOf("client");

    const detail = await getPortalJob(db, client, recent.id);
    expect(detail).toMatchObject({ cancelled: true, milestone: null, milestoneLabel: "Cancelled", links: [], canGiveFeedback: false });
    expect(detail.cancelledAt).toBe(daysAgo(5));
    await expect(getPortalJob(db, client, old.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listPortalJobs(db, client)).map((j) => j.id)).toEqual([recent.id]);
  });
});

describe("projection (§7.4)", () => {
  it("has EXACTLY the whitelisted keys", async () => {
    const j = await job({ statusKey: "delivered", sharedWithClient: true, shootDate: daysAgo(6), deliveryDueDate: daysAgo(1) });
    await addLink(j.id, { shared: true, kind: "client_delivery" });
    await addNote(j.id, "delivery", "Gallery password: ocean");
    const root = await addComment(j.id, ids.users.client, "Love these!");
    await addComment(j.id, ids.users.owner, "Thank you!", { parent: root });

    const detail = await getPortalJob(db, await ctxOf("client"), j.id);
    expect(Object.keys(detail).sort()).toEqual(
      [
        "id", "jobNumber", "name", "project", "jobTypeName", "milestone", "milestoneLabel", "milestoneDetail", "updating", "cancelled",
        "shootDate", "deliveryDueDate", "deliveredAt", "cancelledAt", "photographer", "links", "deliveryNotes", "feedback", "canGiveFeedback",
      ].sort(),
    );
    expect(Object.keys(detail.project).sort()).toEqual(["address", "id", "name"]);
    expect(Object.keys(detail.photographer ?? {}).sort()).toEqual(["name"]);
    expect(Object.keys(detail.links[0] ?? {}).sort()).toEqual(["id", "kind", "label", "provider", "url"]);
    expect(Object.keys(detail.deliveryNotes[0] ?? {}).sort()).toEqual(["authorName", "body", "createdAt", "id"]);
    const thread = detail.feedback[0];
    expect(Object.keys(thread ?? {}).sort()).toEqual(["authorName", "body", "createdAt", "deleted", "editedAt", "id", "isClient", "replies"]);
    expect(Object.keys(thread?.replies[0] ?? {}).sort()).toEqual(["authorName", "body", "createdAt", "deleted", "editedAt", "id", "isClient"]);

    // Nothing staff-only leaks anywhere in the serialised projection.
    const text = JSON.stringify(detail);
    for (const forbidden of [ids.users.editor1, ids.users.owner, "editor", "statusId", "priority", "dueDate\"", "reviewDueDate", "@studio.test"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(detail).toMatchObject({ milestone: "delivered", milestoneLabel: "Delivered", deliveredAt: daysAgo(3), photographer: { name: "Pia Photographer" } });
  });

  it("maps milestones from the DB rows", async () => {
    const booked = await job({ statusKey: "new", sharedWithClient: true, shootDate: "2026-10-12T00:00:00.000Z" });
    const shot = await job({ statusKey: "accepted", sharedWithClient: true, shootDate: daysAgo(2) });
    const editing = await job({ statusKey: "review", sharedWithClient: true });
    const byId = new Map((await listPortalJobs(db, await ctxOf("client"))).map((j) => [j.id, j]));
    expect(byId.get(booked.id)).toMatchObject({ milestone: "booked", milestoneDetail: "Shoot scheduled for 12 Oct" });
    expect(byId.get(shot.id)).toMatchObject({ milestone: "shot" });
    expect(byId.get(editing.id)).toMatchObject({ milestone: "editing", deliveredAt: null });
  });

  it("shows only CURRENT, explicitly shared links", async () => {
    const j = await job({ statusKey: "delivered", sharedWithClient: true });
    const shared = await addLink(j.id, { shared: true, label: "Final gallery" });
    await addLink(j.id, { shared: false, kind: "finished_files" });
    const removed = await addLink(j.id, { shared: true });
    await db.update(jobLinks).set({ removedAt: daysAgo(0), removedByUserId: ids.users.owner }).where(eq(jobLinks.id, removed));
    await addLink(j.id, { shared: true, url: "javascript:alert(1)" });

    const detail = await getPortalJob(db, await ctxOf("client"), j.id);
    expect(detail.links.map((l) => l.id)).toEqual([shared]);
    expect(detail.links[0]?.label).toBe("Final gallery");
  });

  it("shows delivery notes only (never internal or other notes; never archived)", async () => {
    const j = await job({ sharedWithClient: true });
    const visible = await addNote(j.id, "delivery", "Your files are in the Dropbox folder.");
    await addNote(j.id, "delivery", "old", true);
    await addNote(j.id, "internal", "client is slow to pay");
    await addNote(j.id, "photographer", "bring the wide lens");
    const detail = await getPortalJob(db, await ctxOf("client"), j.id);
    expect(detail.deliveryNotes.map((n) => n.id)).toEqual([visible]);
    expect(JSON.stringify(detail)).not.toMatch(/slow to pay|wide lens/);
  });

  it("feedback = client_feedback threads started by the viewer's client; staff comments and previous clients' threads absent", async () => {
    const j = await job({ sharedWithClient: true });
    const mine = await addComment(j.id, ids.users.client, "Can we brighten the kitchen?");
    const reply = await addComment(j.id, ids.users.owner, "Yes, on it.", { parent: mine });
    await addComment(j.id, ids.users.client2, "From the old client"); // a previous client's thread (job changed client)
    await addComment(j.id, ids.users.owner, "Internal: editor is slow", { kind: "comment" });
    await db.update(jobComments).set({ deletedAt: daysAgo(0), deletedByUserId: ids.users.client }).where(eq(jobComments.id, reply));

    const detail = await getPortalJob(db, await ctxOf("client"), j.id);
    expect(detail.feedback).toHaveLength(1);
    expect(detail.feedback[0]).toMatchObject({ id: mine, isClient: true, authorName: "Cleo Client", body: "Can we brighten the kitchen?", deleted: false });
    expect(detail.feedback[0]?.replies).toEqual([expect.objectContaining({ id: reply, deleted: true, body: "", isClient: false })]);
    expect(JSON.stringify(detail)).not.toMatch(/old client|Internal: editor/);
    expect(detail.canGiveFeedback).toBe(true);
    expect(await ownFeedbackIds(db, await ctxOf("client"), j.id)).toEqual([mine]);
  });

  it("canGiveFeedback follows the client's feedback switch", async () => {
    const j = await job({ projectId: ids.projectId2, sharedWithClient: true });
    expect((await getPortalJob(db, await ctxOf("client2"), j.id)).canGiveFeedback).toBe(false);
  });
});

describe("grouping and projects", () => {
  it("groups by project and 404s a project with nothing shared", async () => {
    const [p2] = await db
      .insert(projects)
      .values({ organisationId: ids.organisationId, clientId: ids.clientId, name: "7/22 Campbell Parade", createdAt: NOW, updatedAt: NOW })
      .returning();
    const a = await job({ sharedWithClient: true, name: "A" });
    const b = await job({ sharedWithClient: true, name: "B", projectId: p2!.id });
    await job({ name: "C (unshared)", projectId: p2!.id });
    const client = await ctxOf("client");

    const groups = await listPortalProjectGroups(db, client);
    expect(groups.map((g) => [g.project.id, g.jobs.map((j) => j.id)])).toEqual(
      expect.arrayContaining([
        [ids.projectId, [a.id]],
        [p2!.id, [b.id]],
      ]),
    );
    expect((await getPortalProject(db, client, p2!.id)).jobs.map((j) => j.id)).toEqual([b.id]);
    await expect(getPortalProject(db, client, ids.projectId2)).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadPortalJob(db, client, a.id)).resolves.toMatchObject({ row: { id: a.id } });
  });
});

describe("portal notifications", () => {
  it("lists client types only and forces /portal links", async () => {
    const insert = async (type: "client_work_shared" | "job_assigned" | "client_feedback_reply", linkPath: string) =>
      db.insert(notifications).values({ organisationId: ids.organisationId, userId: ids.users.client, type, title: type, linkPath, createdAt: NOW });
    await insert("client_work_shared", "/portal/jobs/x");
    await insert("job_assigned", "/jobs/x");
    await insert("client_feedback_reply", "/jobs/y?tab=comments");
    const client = await ctxOf("client");
    const items = await listPortalNotifications(db, client);
    expect(items.map((n) => [n.type, n.linkPath]).sort()).toEqual([
      ["client_feedback_reply", "/portal"],
      ["client_work_shared", "/portal/jobs/x"],
    ]);
    expect(await portalUnreadCount(db, client)).toBe(2);
    expect(await portalUnreadCount(db, await ctxOf("owner"))).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Staff side                                                         */
/* ------------------------------------------------------------------ */

describe("getJobClientAccess (job detail card)", () => {
  it("admin: full state and every control", async () => {
    const j = await job({ statusKey: "approved", sharedWithClient: true });
    const link = await addLink(j.id, { shared: true });
    await addNote(j.id, "delivery", "note");
    const root = await addComment(j.id, ids.users.client, "Question?");
    await addComment(j.id, ids.users.client2, "Old client thread", { at: daysAgo(0.5) });

    const access = await getJobClientAccess(db, await ctxOf("owner"), j.id);
    expect(access).not.toBeNull();
    expect(access).toMatchObject({
      sharedWithClient: true,
      visibleToClient: true,
      client: { id: ids.clientId, portalEnabled: true, feedbackEnabled: true, activePortalUsers: 1 },
      can: { shareJob: true, reply: true, addDeliveryNote: true, shareProject: true, managePortal: true },
    });
    expect(access?.links).toEqual([expect.objectContaining({ id: link, sharedWithClient: true, canShare: true })]);
    expect(access?.deliveryNotes).toHaveLength(1);
    expect(access?.feedback.map((t) => [t.id === root, t.waiting, t.fromOtherClient])).toEqual([
      [true, true, false],
      [false, true, true],
    ]);
  });

  it("member without Review submissions sees the state but cannot share or reply", async () => {
    const j = await job({ photographerId: ids.users.photographer1, createdByUserId: ids.users.photographer1 });
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: false });
    const access = await getJobClientAccess(db, await ctxOf("photographer1"), j.id);
    expect(access?.can).toMatchObject({ shareJob: false, reply: false, shareProject: false, managePortal: false });
  });

  it("editors: assigned sees it read-only; no access → 404; clients → 404", async () => {
    const assigned = await job({ statusKey: "in_progress", editorId: ids.users.editor1 });
    const access = await getJobClientAccess(db, await ctxOf("editor1"), assigned.id);
    expect(access?.can).toMatchObject({ shareJob: false, reply: false, turnIntoRevision: false, managePortal: false });
    await expect(getJobClientAccess(db, await ctxOf("editor2"), assigned.id)).rejects.toBeInstanceOf(NotFoundError);
    const shared = await job({ sharedWithClient: true });
    await expect(getJobClientAccess(db, await ctxOf("client"), shared.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("getClientPreview renders the client's projection for staff, flagging visibility", async () => {
    const j = await job({ statusKey: "delivered" });
    await addLink(j.id, { shared: true });
    const preview = await getClientPreview(db, await ctxOf("owner"), j.id);
    expect(preview.visibleToClient).toBe(false);
    expect(preview.job.links).toHaveLength(1);
    expect(preview.job.canGiveFeedback).toBe(false);
  });
});

describe("project sharing + client portal cards", () => {
  it("project sharing: admin can share, members read-only, editors refused", async () => {
    await job({ sharedWithClient: true });
    await job();
    const owner = await getProjectClientSharing(db, await ctxOf("owner"), ids.projectId);
    expect(owner).toMatchObject({ sharedWithClient: false, jobCount: 2, individuallySharedJobs: 1, canShare: true, client: { portalEnabled: true } });
    expect((await getProjectClientSharing(db, await ctxOf("lead"), ids.projectId)).canShare).toBe(false);
    await expect(getProjectClientSharing(db, await ctxOf("editor1"), ids.projectId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("client portal card: admin only; lists the client's portal users", async () => {
    const access = await getClientPortalAccess(db, await ctxOf("owner"), ids.clientId);
    expect(access).toMatchObject({ portalEnabled: true, feedbackEnabled: true, archived: false });
    expect(access.users.map((u) => u.id)).toEqual([ids.users.client]);
    await expect(getClientPortalAccess(db, await ctxOf("lead"), ids.clientId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getClientPortalAccess(db, await ctxOf("owner"), "nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});
