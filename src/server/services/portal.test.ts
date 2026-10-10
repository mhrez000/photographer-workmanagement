import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityEvents, jobComments, users } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import type { Tx } from "@/db/index";
import { newId } from "@/lib/ids";
import type { AuthContext } from "@/lib/types";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import {
  deletePortalFeedback,
  editPortalFeedback,
  getPortalNotificationPrefs,
  postPortalFeedback,
  setPortalNotificationPrefs,
  updatePortalProfile,
} from "./portal";

const NOW = "2026-10-08T00:00:00.000Z";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const ctxOf = async (key: keyof SeedIds["users"]) => contextFor(db, ids.users[key]);
const job = async (opts: JobFixtureOptions = {}) => (await insertJobFixture(db, ids, { at: "2026-10-05T00:00:00.000Z", ...opts })).job;
const tx = <T>(fn: (t: Tx) => Promise<T>) => withTx(fn, { db });

async function staffComment(jobId: string, kind: "comment" | "client_feedback", authorUserId: string, parent?: string) {
  const id = newId();
  await db.insert(jobComments).values({
    id,
    organisationId: ids.organisationId,
    jobId,
    parentCommentId: parent ?? null,
    rootCommentId: parent ?? id,
    authorUserId,
    kind,
    body: "x",
    createdAt: "2026-10-07T00:00:00.000Z",
  });
  return id;
}

const post = (ctx: AuthContext, input: unknown) => tx((t) => postPortalFeedback(t, ctx, input));

describe("postPortalFeedback", () => {
  it("posts a client_feedback root and a reply in the client's own thread, audited", async () => {
    const j = await job({ sharedWithClient: true });
    const client = await ctxOf("client");
    const root = await post(client, { jobId: j.id, body: "Could the sky be bluer?" });
    expect(root).toMatchObject({ body: "Could the sky be bluer?", isClient: true, authorName: "Cleo Client", deleted: false });
    const reply = await post(client, { jobId: j.id, body: "Also the pool", parentCommentId: root.id });

    const rows = await db.select().from(jobComments).where(eq(jobComments.jobId, j.id));
    expect(rows.map((r) => [r.id, r.kind, r.authorUserId, r.rootCommentId]).sort()).toEqual(
      [
        [root.id, "client_feedback", ids.users.client, root.id],
        [reply.id, "client_feedback", ids.users.client, root.id],
      ].sort(),
    );
    const events = await db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.jobId, j.id), eq(activityEvents.eventType, "comment.added")));
    expect(events.map((e) => e.entityId).sort()).toEqual([root.id, reply.id].sort());
  });

  it("404s for unshared jobs, other clients' jobs and threads the client did not start", async () => {
    const unshared = await job();
    const shared = await job({ sharedWithClient: true });
    const client = await ctxOf("client");
    await expect(post(client, { jobId: unshared.id, body: "hi" })).rejects.toBeInstanceOf(NotFoundError);
    // client2 (another client) on Harbour's shared job
    await expect(post(await ctxOf("client2"), { jobId: shared.id, body: "hi" })).rejects.toBeInstanceOf(NotFoundError);
    // a staff comment thread and a thread started by another client's user
    const staffThread = await staffComment(shared.id, "comment", ids.users.owner);
    const foreignThread = await staffComment(shared.id, "client_feedback", ids.users.client2);
    for (const parentCommentId of [staffThread, foreignThread, "nope"]) {
      await expect(post(client, { jobId: shared.id, body: "hi", parentCommentId })).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("403 when feedback is off for the client or the job is cancelled", async () => {
    const own2 = await job({ projectId: ids.projectId2, sharedWithClient: true });
    await expect(post(await ctxOf("client2"), { jobId: own2.id, body: "hi" })).rejects.toBeInstanceOf(ForbiddenError);
    const cancelled = await job({ statusKey: "cancelled", sharedWithClient: true, at: "2026-10-06T00:00:00.000Z" });
    await expect(post(await ctxOf("client"), { jobId: cancelled.id, body: "hi" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects staff contexts and smuggled staff fields", async () => {
    const shared = await job({ sharedWithClient: true });
    await expect(post(await ctxOf("owner"), { jobId: shared.id, body: "hi" })).rejects.toBeInstanceOf(ForbiddenError);
    const client = await ctxOf("client");
    for (const extra of [{ kind: "comment" }, { mentionUserIds: [ids.users.owner] }, { revisionId: "r" }]) {
      await expect(post(client, { jobId: shared.id, body: "hi", ...extra })).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe("edit / delete own feedback", () => {
  it("edits within the window, then refuses; deletes softly", async () => {
    const j = await job({ sharedWithClient: true });
    const client = await ctxOf("client");
    const root = await post(client, { jobId: j.id, body: "First" });
    const edited = await tx((t) => editPortalFeedback(t, client, { commentId: root.id, body: "First (edited)" }));
    expect(edited).toMatchObject({ body: "First (edited)", deleted: false });
    expect(edited.editedAt).not.toBeNull();

    fakeClock.advanceMinutes(16);
    const later = await ctxOf("client");
    await expect(tx((t) => editPortalFeedback(t, later, { commentId: root.id, body: "Too late" }))).rejects.toMatchObject({ status: 403 });

    const deleted = await tx((t) => deletePortalFeedback(t, later, { commentId: root.id }));
    expect(deleted).toMatchObject({ deleted: true, body: "" });
    const [row] = await db.select().from(jobComments).where(eq(jobComments.id, root.id));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.body).toBe("First (edited)"); // soft delete keeps the body
  });

  it("404s for staff comments, staff replies in the client's thread and other clients", async () => {
    const j = await job({ sharedWithClient: true });
    const client = await ctxOf("client");
    const root = await post(client, { jobId: j.id, body: "Question" });
    const staffReply = await staffComment(j.id, "client_feedback", ids.users.owner, root.id);
    const staffThread = await staffComment(j.id, "comment", ids.users.owner);
    for (const commentId of [staffReply, staffThread, "nope"]) {
      await expect(tx((t) => editPortalFeedback(t, client, { commentId, body: "hack" }))).rejects.toBeInstanceOf(NotFoundError);
      await expect(tx((t) => deletePortalFeedback(t, client, { commentId }))).rejects.toBeInstanceOf(NotFoundError);
    }
    // client2 cannot touch Harbour's feedback (job not in their portal)
    await expect(tx(async (t) => deletePortalFeedback(t, await contextFor(t, ids.users.client2), { commentId: root.id }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("portal profile + notification prefs", () => {
  it("renames the portal account (audited) and nothing else", async () => {
    const client = await ctxOf("client");
    const res = await tx((t) => updatePortalProfile(t, client, { name: "Cleo K." }));
    expect(res).toMatchObject({ name: "Cleo K.", email: ids.emails.client });
    const [row] = await db.select().from(users).where(eq(users.id, ids.users.client));
    expect(row?.name).toBe("Cleo K.");
    await expect(tx((t) => updatePortalProfile(t, client, { name: "x", email: "a@b.c" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(tx(async (t) => updatePortalProfile(t, await contextFor(t, ids.users.owner), { name: "x" }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("exposes and sets only the three client notification types", async () => {
    const client = await ctxOf("client");
    expect((await getPortalNotificationPrefs(db, client)).map((p) => p.type).sort()).toEqual(
      ["client_feedback_reply", "client_work_delivered", "client_work_shared"].sort(),
    );
    const after = await tx((t) => setPortalNotificationPrefs(t, client, { prefs: { client_work_shared: false } }));
    expect(after.find((p) => p.type === "client_work_shared")?.enabled).toBe(false);
    await expect(tx((t) => setPortalNotificationPrefs(t, client, { prefs: { job_assigned: false } }))).rejects.toBeInstanceOf(ValidationError);
  });
});
