import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clients, jobComments, jobs, users } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, inviteDefaultsMember, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { endOfCivilDayIso } from "@/lib/dates";
import { ForbiddenError } from "@/server/errors";
import { getOwnerHome } from "./home";

const TZ = "Australia/Sydney";
const NOW = "2026-10-08T00:00:00.000Z"; // Thu 8 Oct 2026, 11:00 AEDT
const due = (civil: string) => endOfCivilDayIso(civil, TZ);

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { at: "2026-09-01T00:00:00.000Z" });
});
afterEach(() => fakeClock.reset());

const job = async (opts: JobFixtureOptions = {}) => (await insertJobFixture(db, ids, opts)).job;
const ctxOf = async (key: keyof SeedIds["users"]) => await contextFor(db, ids.users[key]);

async function comment(jobId: string, author: string, kind: "question" | "comment" | "client_feedback", body: string, createdAt: string, root?: string) {
  const [row] = await db
    .insert(jobComments)
    .values({ organisationId: ids.organisationId, jobId, authorUserId: author, kind, body, createdAt, parentCommentId: root ?? null, rootCommentId: root ?? null })
    .returning({ id: jobComments.id });
  return row.id;
}

describe("getOwnerHome", () => {
  it("empty studio: nothing to check, no attention rows, the simpler notice shows", async () => {
    const home = await getOwnerHome(db, await ctxOf("owner"));
    expect(home.viewer).toMatchObject({ name: "Olivia Owner", isAdmin: true, canReview: true });
    expect(home.topline).toEqual({ toCheck: 0, late: 0, needsEditor: 0 });
    expect(home.readyToCheck).toEqual([]);
    expect(home.needsAttention).toEqual([]);
    expect(home.yourEditors?.map((r) => [r.editor.name, r.onDesk, r.lateNow, r.onTimePctThisMonth, r.notEnough])).toEqual([
      ["Ed Editor", 0, 0, null, true],
      ["Eve Editor", 0, 0, null, true],
    ]);
    expect(home.comingUp).toEqual([]);
    expect(home.emptyStudio).toBe(true);
    expect(home.simplerNotice).toBe(true);
    expect(home.asOf).toBe(NOW);
  });

  it("ready to check: oldest send first, round badge, finished link, portal share question", async () => {
    await db.update(clients).set({ portalEnabled: false }).where(eq(clients.id, ids.clientId2));
    const r1 = await job({ statusKey: "submitted", at: "2026-10-06T00:00:00.000Z", name: "First sent" });
    const r2 = await job({ statusKey: "resubmitted", at: "2026-10-07T00:00:00.000Z", name: "Round two", projectId: ids.projectId2 });
    await db.update(jobs).set({ revisionCount: 1 }).where(eq(jobs.id, r2.id));
    await job({ statusKey: "in_progress" });
    const home = await getOwnerHome(db, await ctxOf("owner"));
    expect(home.topline.toCheck).toBe(2);
    expect(home.readyToCheck.map((c) => c.job.id)).toEqual([r1.id, r2.id]);
    expect(home.readyToCheck[0]).toMatchObject({ sentAt: "2026-10-06T00:00:00.000Z", sentAgoSeconds: 2 * 86_400, round: null, canCheck: true, selfReviewNeedsConfirm: false, checkedBy: null, shareQuestion: true });
    expect(home.readyToCheck[1]).toMatchObject({ round: 2, shareQuestion: false });
    expect(home.emptyStudio).toBe(false);
  });

  it("owners may check a job they edited themselves after confirming; co-owners need no confirm", async () => {
    const mine = await job({ statusKey: "submitted", editorId: ids.users.owner });
    const asOwner = (await getOwnerHome(db, await ctxOf("owner"))).readyToCheck.find((c) => c.job.id === mine.id);
    expect(asOwner).toMatchObject({ canCheck: true, selfReviewNeedsConfirm: true });
    const asCoAdmin = (await getOwnerHome(db, await ctxOf("coAdmin"))).readyToCheck.find((c) => c.job.id === mine.id);
    expect(asCoAdmin).toMatchObject({ canCheck: true, selfReviewNeedsConfirm: false });
  });

  it("needs attention: late · no editor yet (shot before today) · question from an editor · message from the client", async () => {
    const late = await job({ statusKey: "in_progress", dueDate: due("2026-10-06"), name: "Late one" });
    const noEditor = await job({ statusKey: "new", editorId: null, shootDate: due("2026-10-06"), name: "Shot Tuesday" });
    await job({ statusKey: "new", editorId: null, shootDate: due("2026-10-08"), name: "Shot today" }); // needs an editor but is not an attention row yet
    const asked = await job({ statusKey: "assigned", name: "Question" });
    await comment(asked.id, ids.users.editor1, "question", "Which sky?", "2026-10-07T01:00:00.000Z");
    const answered = await job({ statusKey: "assigned", name: "Answered" });
    const root = await comment(answered.id, ids.users.editor1, "question", "Crop?", "2026-10-07T02:00:00.000Z");
    await comment(answered.id, ids.users.owner, "comment", "Square", "2026-10-07T03:00:00.000Z", root);
    const fb = await job({ statusKey: "delivered", name: "Client said" });
    await comment(fb.id, ids.users.client, "client_feedback", "Brighter please", "2026-10-07T04:00:00.000Z");
    const replied = await job({ statusKey: "delivered", name: "Replied" });
    const fbRoot = await comment(replied.id, ids.users.client, "client_feedback", "Thanks", "2026-10-07T05:00:00.000Z");
    await comment(replied.id, ids.users.owner, "comment", "You're welcome", "2026-10-07T06:00:00.000Z", fbRoot);

    const home = await getOwnerHome(db, await ctxOf("owner"));
    expect(home.topline).toEqual({ toCheck: 0, late: 1, needsEditor: 2 });
    expect(home.needsAttention.map((r) => [r.job.id, r.reason.kind])).toEqual([
      [late.id, "late"],
      [noEditor.id, "no_editor"],
      [asked.id, "question"],
      [fb.id, "client_message"],
    ]);
    expect(home.needsAttention[0].reason).toEqual({ kind: "late", daysLate: 2, withName: "Eve Editor" });
    expect(home.needsAttention[1].reason).toEqual({ kind: "no_editor", shotCivilDate: "2026-10-06" });
    expect(home.needsAttention[2].reason).toMatchObject({ kind: "question", from: { name: "Eve Editor" }, excerpt: "Which sky?" });
    expect(home.needsAttention[3].reason).toMatchObject({ kind: "client_message", excerpt: "Brighter please" });
  });

  it("coming up: shoots and due dates in the next 7 days (active stages only), soonest first", async () => {
    const a = await job({ statusKey: "new", editorId: null, shootDate: due("2026-10-10"), dueDate: due("2026-10-12") });
    await job({ statusKey: "approved", dueDate: due("2026-10-09") }); // done
    await job({ statusKey: "in_progress", dueDate: due("2026-10-20") }); // beyond 7 days
    const today = await job({ statusKey: "assigned", dueDate: due("2026-10-08") });
    const home = await getOwnerHome(db, await ctxOf("owner"));
    expect(home.comingUp.map((c) => [c.kind, c.civilDate, c.job.id])).toEqual([
      ["due", "2026-10-08", today.id],
      ["shoot", "2026-10-10", a.id],
      ["due", "2026-10-12", a.id],
    ]);
  });

  it("your editors (owner only) uses the Editors page numbers", async () => {
    await job({ statusKey: "in_progress", dueDate: due("2026-10-01") });
    await job({ statusKey: "revision", editorId: ids.users.editor2 });
    const home = await getOwnerHome(db, await ctxOf("owner"));
    expect(home.yourEditors?.map((r) => [r.editor.name, r.onDesk, r.lateNow, r.onTimePctThisMonth, r.notEnough])).toEqual([
      ["Eve Editor", 1, 1, null, true],
      ["Ed Editor", 1, 0, null, true],
    ]);
    expect((await getOwnerHome(db, await ctxOf("photographer1"))).yourEditors).toBeNull();
  });

  it("an extra photographer sees only their own shoots; without Review submissions the cards say who will check", async () => {
    const mine = await job({ statusKey: "submitted", photographerId: ids.users.photographer1, dueDate: due("2026-10-10") });
    await job({ statusKey: "submitted", photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 });
    await job({ statusKey: "in_progress", photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2, dueDate: due("2026-10-01") });
    const p1 = await getOwnerHome(db, await ctxOf("photographer1"));
    expect(p1.viewer).toMatchObject({ isAdmin: false, canReview: true });
    expect(p1.topline).toEqual({ toCheck: 1, late: 0, needsEditor: 0 });
    expect(p1.readyToCheck.map((c) => c.job.id)).toEqual([mine.id]);
    expect(p1.readyToCheck[0]).toMatchObject({ canCheck: true, checkedBy: null });

    const junior = await inviteDefaultsMember(db, ids); // review ✗ → the owner checks
    const theirs = await job({ statusKey: "submitted", photographerId: junior, createdByUserId: junior });
    const jr = await getOwnerHome(db, await contextFor(db, junior));
    expect(jr.viewer.canReview).toBe(false);
    expect(jr.readyToCheck.map((c) => c.job.id)).toEqual([theirs.id]);
    expect(jr.readyToCheck[0]).toMatchObject({ canCheck: false, selfReviewNeedsConfirm: false, checkedBy: "Olivia Owner" });
    expect(jr.yourEditors).toBeNull();
  });

  it("the simpler notice hides once dismissed (column from migration 0004)", async () => {
    await db.update(users).set({ simplerNoticeDismissedAt: NOW }).where(eq(users.id, ids.users.owner));
    expect((await getOwnerHome(db, await ctxOf("owner"))).simplerNotice).toBe(false);
    expect((await getOwnerHome(db, await ctxOf("coAdmin"))).simplerNotice).toBe(true);
  });

  it("editors and clients do not get Home", async () => {
    await expect(getOwnerHome(db, await ctxOf("editor1"))).rejects.toThrow(ForbiddenError);
    await expect(getOwnerHome(db, await ctxOf("client"))).rejects.toThrow(ForbiddenError);
  });
});
