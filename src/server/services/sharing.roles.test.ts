/**
 * Roles v2 link / note / sharing rules (docs/ROLES.md §3.3 †, §3.5, §7.1–§7.3):
 * link sharing (current links only, trigger freeze, added_by_sharer immutable,
 * inheritance on replace / re-file), review-gated link writes, strict link
 * schemas, delivery notes, project sharing and the client portal switches.
 */
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, clients, jobLinks, notifications, projects } from "@/db/schema";
import { contextFor, dbRejection, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, setUserFlags, systemContextFor, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { AppError } from "@/server/errors";
import { withTx } from "./_shared";
import { addLink, listLinks, removeLink, replaceLink, updateLink } from "./links";
import { addNote, listNotes } from "./notes";
import { setClientPortal, shareLink, shareProject } from "./sharing";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

async function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T>): Promise<T> {
  const ctx = await contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}
async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err.status;
    throw err;
  }
  return 200;
}
const linkRow = async (id: string) => first(db.select().from(jobLinks).where(eq(jobLinks.id, id)));
const eventsOf = (type: string) =>
  db.select().from(activityEvents).where(eq(activityEvents.eventType, type as never)).orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));

describe("link sharing", () => {
  it("shares a current link (event, idempotent); superseded / removed → 400; the trigger freezes old rows", async () => {
    const jobId = (await insertJobFixture(db, ids, { statusKey: "approved", createdByUserId: ids.users.owner })).job.id;
    const v1 = await run(ids.users.owner, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "gallery", url: "https://studio.pixieset.com/1" }));
    expect(v1).toMatchObject({ sharedWithClient: false, addedBySharer: true });
    const shared = await run(ids.users.owner, (tx, ctx) => shareLink(tx, ctx, { linkId: v1.id, shared: true }));
    expect(shared).toMatchObject({ changed: true, link: { sharedWithClient: true } });
    expect((await run(ids.users.owner, (tx, ctx) => shareLink(tx, ctx, { linkId: v1.id, shared: true }))).changed).toBe(false);
    const evt = (await eventsOf("link.client_sharing_changed"))[0];
    expect(evt).toMatchObject({ jobId, entityId: v1.id, newValue: { shared: true } });
    expect(evt.metadata).toMatchObject({ reason: "manual", kind: "gallery" });

    const v2 = await run(ids.users.owner, (tx, ctx) => replaceLink(tx, ctx, { linkId: v1.id, url: "https://studio.pixieset.com/2" }));
    expect(v2.link.sharedWithClient).toBe(true); // an admin's replacement inherits the share
    expect(await status(run(ids.users.owner, (tx, ctx) => shareLink(tx, ctx, { linkId: v1.id, shared: false })))).toBe(400);
    expect(await dbRejection(db.$client.query("UPDATE job_links SET shared_with_client = false WHERE id = $1", [v1.id]))).toMatch(/./);
    expect(await dbRejection(db.$client.query("UPDATE job_links SET added_by_sharer = false WHERE id = $1", [v2.link.id]))).toMatch(/./);
    const removed = await run(ids.users.owner, (tx, ctx) => removeLink(tx, ctx, { linkId: v2.link.id }));
    expect(await status(run(ids.users.owner, (tx, ctx) => shareLink(tx, ctx, { linkId: removed.id, shared: true })))).toBe(400);
  });

  it("who may share: admins; members on managed jobs with Review submissions; never editors", async () => {
    const jobId = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job.id; // photographer1's job, editor1 holds it
    const link = await run(ids.users.editor1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "finished_files", url: "https://drive.google.com/x" }));
    expect(link.addedBySharer).toBe(false);
    expect(await status(run(ids.users.editor1, (tx, ctx) => shareLink(tx, ctx, { linkId: link.id, shared: true })))).toBe(403);
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: false });
    expect(await status(run(ids.users.photographer1, (tx, ctx) => shareLink(tx, ctx, { linkId: link.id, shared: true })))).toBe(403);
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: true });
    expect((await run(ids.users.photographer1, (tx, ctx) => shareLink(tx, ctx, { linkId: link.id, shared: true }))).changed).toBe(true);
    // an editor never replaces / removes a shared link
    expect(await status(run(ids.users.editor1, (tx, ctx) => replaceLink(tx, ctx, { linkId: link.id, url: "https://drive.google.com/y" })))).toBe(403);
    expect(await status(run(ids.users.editor1, (tx, ctx) => removeLink(tx, ctx, { linkId: link.id })))).toBe(403);
    // listLinks shows the client visibility
    const slots = await listLinks(db, await contextFor(db, ids.users.owner), jobId);
    expect(slots[0]?.current?.sharedWithClient).toBe(true);
  });

  it("replace / re-file by someone who cannot share drops the share (metadata.sharingDropped)", async () => {
    const jobId = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job.id;
    const ref = await run(ids.users.photographer1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "reference", url: "https://example.com/plan.pdf" }));
    await run(ids.users.owner, (tx, ctx) => shareLink(tx, ctx, { linkId: ref.id, shared: true }));
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: false });
    const replaced = await run(ids.users.photographer1, (tx, ctx) => replaceLink(tx, ctx, { linkId: ref.id, url: "https://example.com/plan-v2.pdf" }));
    expect(replaced.link).toMatchObject({ sharedWithClient: false, addedBySharer: false });
    expect((await eventsOf("link.replaced"))[0].metadata).toMatchObject({ sharingDropped: true, sharedWithClient: false });
    // re-file keeps the share for an admin
    await run(ids.users.owner, (tx, ctx) => shareLink(tx, ctx, { linkId: replaced.link.id, shared: true }));
    const refiled = await run(ids.users.owner, (tx, ctx) => updateLink(tx, ctx, { linkId: replaced.link.id, label: "Floor plan" }));
    expect(refiled).toMatchObject({ sharedWithClient: true, addedBySharer: true });
  });

  it("review-gated jobs: editors write no links; members without Review can't touch client-facing or shared links", async () => {
    const jobId = (await insertJobFixture(db, ids, { statusKey: "submitted" })).job.id;
    expect(await status(run(ids.users.editor1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "finished_files", url: "https://drive.google.com/late" })))).toBe(403);
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: false });
    expect(await status(run(ids.users.photographer1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "gallery", url: "https://studio.pixieset.com/g" })))).toBe(403);
    // a non-client-facing kind is fine
    const raw = await run(ids.users.photographer1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "reference", url: "https://example.com/r" }));
    await run(ids.users.owner, (tx, ctx) => shareLink(tx, ctx, { linkId: raw.id, shared: true }));
    expect(await status(run(ids.users.photographer1, (tx, ctx) => removeLink(tx, ctx, { linkId: raw.id })))).toBe(403);
  });

  it("strict link schemas reject sharing columns", async () => {
    const jobId = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job.id;
    expect(await status(run(ids.users.owner, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "gallery", url: "https://x.com/a", sharedWithClient: true })))).toBe(400);
    const link = await run(ids.users.owner, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "gallery", url: "https://x.com/a" }));
    expect(await status(run(ids.users.owner, (tx, ctx) => replaceLink(tx, ctx, { linkId: link.id, url: "https://x.com/b", sharedWithClient: true })))).toBe(400);
    expect(await status(run(ids.users.owner, (tx, ctx) => updateLink(tx, ctx, { linkId: link.id, label: "x", addedBySharer: false })))).toBe(400);
    expect((await linkRow(link.id))?.sharedWithClient).toBe(false);
  });
});

describe("delivery notes", () => {
  it("admins and reviewing members write them; editors and non-reviewing members don't; automations never", async () => {
    const jobId = (await insertJobFixture(db, ids, { statusKey: "approved" })).job.id;
    await run(ids.users.owner, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "delivery", body: "Ready for you" }));
    await run(ids.users.photographer1, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "delivery", body: "Squares included" }));
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: false });
    expect(await status(run(ids.users.photographer1, (tx, ctx) => addNote(tx, ctx, { jobId, kind: "delivery", body: "x" })))).toBe(403);
    const editing = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job.id;
    expect(await status(run(ids.users.editor1, (tx, ctx) => addNote(tx, ctx, { jobId: editing, kind: "delivery", body: "x" })))).toBe(403);
    const sys = await systemContextFor(db, ids.organisationId);
    expect(await status(withTx((tx) => addNote(tx, sys, { jobId, kind: "delivery", body: "auto" }), { db }))).toBe(400);
  });

  it("editors read delivery and photographer notes but never internal / client notes; internal stays with managers of the job", async () => {
    const jobId = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job.id;
    for (const kind of ["delivery", "internal", "client", "photographer"] as const) {
      await run(ids.users.owner, (tx, ctx) => addNote(tx, ctx, { jobId, kind, body: kind }));
    }
    expect((await listNotes(db, await contextFor(db, ids.users.editor1), jobId)).map((n) => n.kind).sort()).toEqual(["delivery", "photographer"]);
    // a See-all-jobs member who does not manage the job: no internal notes
    await setUserFlags(db, ids.users.photographer2, { canViewAllJobs: true });
    expect((await listNotes(db, await contextFor(db, ids.users.photographer2), jobId)).map((n) => n.kind).sort()).toEqual(["client", "delivery", "photographer"]);
  });
});

describe("project sharing and the client portal switches (admin)", () => {
  it("shareProject: admin only, versioned, audited with jobCount, portal users told once", async () => {
    await insertJobFixture(db, ids, { statusKey: "in_progress" });
    await insertJobFixture(db, ids, { statusKey: "new" });
    const project = await first(db.select().from(projects).where(eq(projects.id, ids.projectId)));
    expect(await status(run(ids.users.lead, (tx, ctx) => shareProject(tx, ctx, { projectId: ids.projectId, shared: true, expectedVersion: project?.version ?? 1 })))).toBe(403);
    const res = await run(ids.users.owner, (tx, ctx) => shareProject(tx, ctx, { projectId: ids.projectId, shared: true, expectedVersion: project?.version ?? 1 }));
    expect(res).toMatchObject({ changed: true, jobCount: 2, project: { sharedWithClient: true } });
    expect((await eventsOf("project.client_sharing_changed"))[0].metadata).toMatchObject({ reason: "manual", jobCount: 2 });
    const sent = await db.select().from(notifications).where(eq(notifications.type, "client_work_shared"));
    expect(sent.map((n) => [n.userId, n.title])).toEqual([[ids.users.client, "2 jobs at 123 Smith Street are now available"]]);
    expect(await status(run(ids.users.owner, (tx, ctx) => shareProject(tx, ctx, { projectId: ids.projectId, shared: false, expectedVersion: project?.version ?? 1 })))).toBe(409);
    expect(await status(run(ids.users.owner, (tx, ctx) => shareProject(tx, ctx, { projectId: ids.projectId, shared: true, expectedVersion: 2, extra: 1 })))).toBe(400);
  });

  it("setClientPortal: admin only; turning the portal off signs its users out (no context)", async () => {
    const before = await first(db.select().from(clients).where(eq(clients.id, ids.clientId)));
    expect(await status(run(ids.users.lead, (tx, ctx) => setClientPortal(tx, ctx, { clientId: ids.clientId, portalEnabled: false, expectedVersion: before?.version ?? 1 })))).toBe(403);
    const res = await run(ids.users.owner, (tx, ctx) => setClientPortal(tx, ctx, { clientId: ids.clientId, portalEnabled: false, expectedVersion: before?.version ?? 1 }));
    expect(res).toMatchObject({ changed: ["portalEnabled"], client: { portalEnabled: false, feedbackEnabled: true } });
    expect((await eventsOf("client.portal_updated"))[0]).toMatchObject({ previousValue: { portalEnabled: true }, newValue: { portalEnabled: false } });
    await expect(contextFor(db, ids.users.client)).rejects.toThrow(/missing or inactive/);
    expect(await status(run(ids.users.owner, (tx, ctx) => setClientPortal(tx, ctx, { clientId: ids.clientId, expectedVersion: res.client.version })))).toBe(400);
  });
});
