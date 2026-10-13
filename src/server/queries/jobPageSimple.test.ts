import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clients, jobComments, jobLinks, jobNotes } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, inviteDefaultsMember, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { endOfCivilDayIso } from "@/lib/dates";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { getJobPageSimple } from "./jobPageSimple";
import { addRevision, moveJob, reattribute } from "./test-history";

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

describe("getJobPageSimple — access", () => {
  it("404s for missing, foreign and not-visible jobs; 403 for clients", async () => {
    const j = await job({ statusKey: "in_progress" });
    const other = await seedMinimalOrg(db, { slug: "other" });
    const foreign = (await insertJobFixture(db, other, { statusKey: "in_progress" })).job;
    await expect(getJobPageSimple(db, await ctxOf("owner"), "missing")).rejects.toThrow(NotFoundError);
    await expect(getJobPageSimple(db, await ctxOf("owner"), foreign.id)).rejects.toThrow(NotFoundError);
    await expect(getJobPageSimple(db, await ctxOf("photographer2"), j.id)).rejects.toThrow(NotFoundError);
    await expect(getJobPageSimple(db, await ctxOf("editor2"), j.id)).rejects.toThrow(NotFoundError);
    await expect(getJobPageSimple(db, await ctxOf("client"), j.id)).rejects.toThrow(ForbiddenError);
    expect((await getJobPageSimple(db, await ctxOf("editor1"), j.id)).header.id).toBe(j.id);
  });
});

describe("header + next step per stage and viewer", () => {
  it("Needs editor: the owner assigns (with the picker), the photographer too; editors never see it", async () => {
    const j = await job({ statusKey: "new", editorId: null, dueDate: due("2026-10-07"), priority: "urgent" });
    const page = await getJobPageSimple(db, await ctxOf("owner"), j.id);
    expect(page.header).toMatchObject({ stage: { stage: "needs_editor", label: "Needs editor" }, waitingOn: "Pia Photographer", due: { late: true, daysFromToday: -1 }, rush: true, round: null, editedBy: null });
    expect(page.nextStep).toMatchObject({ kind: "assign_editor", viewer: "reviewer", allowed: true, shareQuestion: false, selfReviewNeedsConfirm: false });
    expect(page.nextStep.editorOptions?.map((o) => o.editor.name)).toEqual(["Ed Editor", "Eve Editor"]);
    const asP1 = await getJobPageSimple(db, await ctxOf("photographer1"), j.id);
    expect(asP1.header.waitingOn).toBe("You");
    expect(asP1.nextStep).toMatchObject({ kind: "assign_editor", allowed: true });
    expect(asP1.nextStep.editorOptions).not.toBeNull();
    const junior = await inviteDefaultsMember(db, ids);
    const theirs = await job({ statusKey: "new", editorId: null, photographerId: junior, createdByUserId: junior });
    expect((await getJobPageSimple(db, await contextFor(db, junior), theirs.id)).nextStep).toMatchObject({ kind: "assign_editor", allowed: true });
  });

  it("With editor: the editor starts (then sends once a finished link exists); the owner may change editor", async () => {
    const j = await job({ statusKey: "assigned" });
    const e1 = await ctxOf("editor1");
    let page = await getJobPageSimple(db, e1, j.id);
    expect(page.header.stage.subLabel).toBe("not_started");
    expect(page.header.waitingOn).toBe("You");
    expect(page.nextStep).toMatchObject({ kind: "start_editing", viewer: "editor", allowed: true, editorOptions: null, hasFinishedLink: false });
    expect(page.permissions.canDecline).toBe(true);
    const owner = await getJobPageSimple(db, await ctxOf("owner"), j.id);
    expect(owner.nextStep).toMatchObject({ kind: "change_editor", viewer: "reviewer", allowed: true });
    expect(owner.nextStep.editorOptions).toHaveLength(2);
    expect(owner.permissions).toMatchObject({ canChangeEditor: true, canTakeBack: true, canCancel: true, canReopen: false, canDecline: false });

    await moveJob(db, ids, j.id, "in_progress", "2026-10-07T00:00:00.000Z", { actorUserId: ids.users.editor1 });
    page = await getJobPageSimple(db, e1, j.id);
    expect(page.header.stage.subLabel).toBe("editing");
    expect(page.nextStep).toMatchObject({ kind: "send_for_checking", allowed: true, hasFinishedLink: false, lastFinishedLink: null });
    await db.insert(jobLinks).values({ organisationId: ids.organisationId, jobId: j.id, kind: "finished_files", url: "https://x.example/f1", addedByUserId: ids.users.editor1 });
    page = await getJobPageSimple(db, e1, j.id);
    expect(page.nextStep).toMatchObject({ hasFinishedLink: true, lastFinishedLink: { url: "https://x.example/f1" } });
  });

  it("Ready to check: the reviewer gets Approve / Ask for changes with the share question; the editor only waits", async () => {
    const j = await job({ statusKey: "submitted", at: "2026-10-07T00:00:00.000Z" });
    const owner = await getJobPageSimple(db, await ctxOf("owner"), j.id);
    expect(owner.header.waitingOn).toBe("Pia Photographer");
    expect(owner.nextStep).toMatchObject({ kind: "check", viewer: "reviewer", allowed: true, shareQuestion: true, selfReviewNeedsConfirm: false, sentAt: "2026-10-07T00:00:00.000Z" });
    const editor = await getJobPageSimple(db, await ctxOf("editor1"), j.id);
    expect(editor.nextStep).toMatchObject({ kind: "none", viewer: "editor", allowed: false });
    // photographer with Review submissions checks their own shoots (§12.4); a junior without it cannot
    expect((await getJobPageSimple(db, await ctxOf("photographer1"), j.id)).nextStep).toMatchObject({ kind: "check", allowed: true });
    const junior = await inviteDefaultsMember(db, ids);
    const theirs = await job({ statusKey: "submitted", photographerId: junior, createdByUserId: junior });
    expect((await getJobPageSimple(db, await contextFor(db, junior), theirs.id)).nextStep).toMatchObject({ kind: "check", viewer: "reviewer", allowed: false });
    // no portal → no share question
    await db.update(clients).set({ portalEnabled: false }).where(eq(clients.id, ids.clientId));
    const noPortal = await getJobPageSimple(db, await ctxOf("owner"), j.id);
    expect(noPortal.nextStep.shareQuestion).toBe(false);
    expect(noPortal.sideColumn).toMatchObject({ clientHasPortal: false, clientDeliveryDate: null });
    expect(noPortal.fromClient).toBeNull();
  });

  it("owners who edited the job themselves confirm before approving; regular photographers stay blocked", async () => {
    const mine = await job({ statusKey: "submitted", editorId: ids.users.owner });
    expect((await getJobPageSimple(db, await ctxOf("owner"), mine.id)).nextStep).toMatchObject({ kind: "check", allowed: true, selfReviewNeedsConfirm: true });
    expect((await getJobPageSimple(db, await ctxOf("coAdmin"), mine.id)).nextStep).toMatchObject({ kind: "check", allowed: true, selfReviewNeedsConfirm: false });
    const p1Edited = await job({ statusKey: "submitted", editorId: ids.users.photographer1 });
    expect((await getJobPageSimple(db, await ctxOf("photographer1"), p1Edited.id)).nextStep).toMatchObject({ kind: "check", allowed: false, selfReviewNeedsConfirm: false });
  });

  it("Done shows no step (owner may reopen); Cancelled offers Restore", async () => {
    const done = await job({ statusKey: "approved" });
    const page = await getJobPageSimple(db, await ctxOf("owner"), done.id);
    expect(page.header.stage).toMatchObject({ stage: "done", subLabel: "not_sent_to_client" });
    expect(page.nextStep.kind).toBe("none");
    expect(page.permissions).toMatchObject({ canReopen: true, canRestore: false });
    const cancelled = await job({ statusKey: "cancelled", editorId: ids.users.editor1 });
    const c = await getJobPageSimple(db, await ctxOf("owner"), cancelled.id);
    expect(c.nextStep).toMatchObject({ kind: "restore", allowed: true });
    expect(c.permissions.canRestore).toBe(true);
    expect((await getJobPageSimple(db, await ctxOf("editor1"), cancelled.id)).nextStep.kind).toBe("none");
  });
});

describe("sections", () => {
  it("files: raw · finished (+ earlier versions) · other links", async () => {
    const j = await job({ statusKey: "in_progress" });
    const add = (over: Partial<typeof jobLinks.$inferInsert>) =>
      db.insert(jobLinks).values({ organisationId: ids.organisationId, jobId: j.id, kind: "finished_files", url: "https://x.example", addedByUserId: ids.users.editor1, createdAt: NOW, ...over }).returning({ id: jobLinks.id });
    await add({ kind: "raw_files", url: "https://x.example/raw", addedByUserId: ids.users.photographer1, createdAt: "2026-10-01T00:00:00.000Z" });
    const [old] = await add({ url: "https://x.example/v1", createdAt: "2026-10-05T00:00:00.000Z" });
    const [cur] = await add({ url: "https://x.example/v2", createdAt: "2026-10-06T00:00:00.000Z", supersedesLinkId: old.id });
    await db.update(jobLinks).set({ supersededAt: "2026-10-06T00:00:00.000Z", supersededByLinkId: cur.id }).where(eq(jobLinks.id, old.id));
    await add({ kind: "reference", url: "https://x.example/floorplan", addedByUserId: ids.users.photographer1 });
    const page = await getJobPageSimple(db, await ctxOf("owner"), j.id);
    expect(page.files.raw?.url).toBe("https://x.example/raw");
    expect(page.files.finished?.url).toBe("https://x.example/v2");
    expect(page.files.earlierVersions.map((l) => l.url)).toEqual(["https://x.example/v1"]);
    expect(page.files.other.map((l) => l.kind)).toEqual(["reference"]);
  });

  it("instructions merge the description with photographer / editor notes; private notes stay in their own box", async () => {
    const j = await job({ statusKey: "in_progress", description: "Twilight set, 25 images" });
    const note = (kind: "photographer" | "editor" | "internal" | "client", body: string, author: string, createdAt: string) =>
      db.insert(jobNotes).values({ organisationId: ids.organisationId, jobId: j.id, kind, body, authorUserId: author, createdAt, updatedAt: createdAt });
    await note("photographer", "Straighten verticals", ids.users.photographer1, "2026-10-02T00:00:00.000Z");
    await note("editor", "Done the hero", ids.users.editor1, "2026-10-03T00:00:00.000Z");
    await note("internal", "Client is fussy", ids.users.owner, "2026-10-04T00:00:00.000Z");
    await note("client", "Prefers warm tones", ids.users.owner, "2026-10-05T00:00:00.000Z");
    const owner = await getJobPageSimple(db, await ctxOf("owner"), j.id);
    expect(owner.instructions.map((i) => [i.source, i.body])).toEqual([
      ["description", "Twilight set, 25 images"],
      ["photographer", "Straighten verticals"],
      ["editor", "Done the hero"],
    ]);
    expect(owner.privateNotes?.map((n) => n.kind).sort()).toEqual(["client", "internal"]);
    expect(owner.permissions.canAddPrivateNote).toBe(true);
    const editor = await getJobPageSimple(db, await ctxOf("editor1"), j.id);
    expect(editor.instructions).toHaveLength(3);
    expect(editor.privateNotes).toBeNull();
    expect(editor.fromClient).toBeNull();
  });

  it("messages are the staff thread; client feedback sits under From the client (staff only, portal clients only)", async () => {
    const j = await job({ statusKey: "delivered" });
    await db.insert(jobComments).values({ organisationId: ids.organisationId, jobId: j.id, authorUserId: ids.users.editor1, kind: "question", body: "Which crop?", createdAt: "2026-10-06T00:00:00.000Z" });
    await db.insert(jobComments).values({ organisationId: ids.organisationId, jobId: j.id, authorUserId: ids.users.client, kind: "client_feedback", body: "Love them", createdAt: "2026-10-07T00:00:00.000Z" });
    const owner = await getJobPageSimple(db, await ctxOf("owner"), j.id);
    expect(owner.messages.map((c) => c.body)).toEqual(["Which crop?"]);
    expect(owner.fromClient?.map((c) => c.body)).toEqual(["Love them"]);
    expect(owner.permissions.canReplyToClient).toBe(true);
    expect(owner.sideColumn.clientHasPortal).toBe(true);
    const editor = await getJobPageSimple(db, await ctxOf("editor1"), j.id);
    expect(editor.messages.map((c) => c.body)).toEqual(["Which crop?"]);
    expect(editor.fromClient).toBeNull();
    expect(editor.permissions.canReplyToClient).toBe(false);
  });

  it("changes asked lists every round with who, when and Fixed / Open", async () => {
    const j = await job({ statusKey: "revision", dueDate: due("2026-10-10") });
    await addRevision(db, ids, j.id, 1, "2026-10-05T00:00:00.000Z");
    await db.insert((await import("@/db/schema")).jobRevisions).values({
      organisationId: ids.organisationId,
      jobId: j.id,
      revisionNumber: 2,
      requestedByUserId: ids.users.owner,
      reason: "Crop",
      description: "Tighter on the kitchen",
      requestedAt: "2026-10-07T00:00:00.000Z",
    });
    const page = await getJobPageSimple(db, await ctxOf("owner"), j.id);
    expect(page.changesAsked.map((r) => [r.round, r.what, r.who.name, r.status])).toEqual([
      [1, "Fix colour", "Cora Co-Admin", "fixed"],
      [2, "Tighter on the kitchen", "Olivia Owner", "open"],
    ]);
    expect(page.header.stage).toMatchObject({ stage: "changes_asked", label: "Changes asked" });
    expect(page.header.waitingOn).toBe("Eve Editor");
  });

  it("who did what follows the ledgers: created · given to · started · sent (on time) · changes asked · sent back · approved · sent to client", async () => {
    const j = await job({ statusKey: "assigned", at: "2026-10-01T00:00:00.000Z", dueDate: due("2026-10-05") });
    await moveJob(db, ids, j.id, "in_progress", "2026-10-02T00:00:00.000Z", { actorUserId: ids.users.editor1 });
    await moveJob(db, ids, j.id, "submitted", "2026-10-04T00:00:00.000Z", { actorUserId: ids.users.editor1 });
    await moveJob(db, ids, j.id, "revision", "2026-10-05T00:00:00.000Z", { actorUserId: ids.users.owner });
    await addRevision(db, ids, j.id, 1, "2026-10-05T00:00:00.000Z");
    await moveJob(db, ids, j.id, "resubmitted", "2026-10-06T00:00:00.000Z", { actorUserId: ids.users.editor1 });
    await moveJob(db, ids, j.id, "approved", "2026-10-07T00:00:00.000Z", { actorUserId: ids.users.owner });
    await moveJob(db, ids, j.id, "delivered", "2026-10-07T01:00:00.000Z", { actorUserId: ids.users.owner });
    const page = await getJobPageSimple(db, await ctxOf("owner"), j.id);
    expect(page.whoDidWhat.map((e) => e.kind)).toEqual(["created", "given_to", "started", "sent_for_checking", "changes_asked", "sent_back", "approved", "sent_to_client"]);
    const sent = page.whoDidWhat.find((e) => e.kind === "sent_for_checking");
    expect(sent).toMatchObject({ onTime: true, actor: { name: "Eve Editor" } });
    expect(page.whoDidWhat.find((e) => e.kind === "given_to")).toMatchObject({ subject: { name: "Eve Editor" } });
    expect(page.whoDidWhat.find((e) => e.kind === "changes_asked")).toMatchObject({ round: 1, actor: { name: "Cora Co-Admin" } });
    expect(page.whoDidWhat.find((e) => e.kind === "approved")?.actor?.name).toBe("Olivia Owner");
    expect(page.header.stage.stage).toBe("done");
  });

  it("a late send and a change of editor show as late / moved to", async () => {
    const j = await job({ statusKey: "assigned", at: "2026-10-01T00:00:00.000Z", dueDate: due("2026-10-02") });
    await reattribute(db, ids, j.id, ids.users.editor2, "2026-10-02T00:00:00.000Z");
    await moveJob(db, ids, j.id, "in_progress", "2026-10-03T00:00:00.000Z", { actorUserId: ids.users.editor2 });
    await moveJob(db, ids, j.id, "submitted", "2026-10-04T00:00:00.000Z", { actorUserId: ids.users.editor2 });
    const page = await getJobPageSimple(db, await ctxOf("owner"), j.id);
    expect(page.whoDidWhat.map((e) => e.kind)).toEqual(["created", "given_to", "given_to", "moved_to", "started", "sent_for_checking"]);
    expect(page.whoDidWhat.find((e) => e.kind === "moved_to")?.subject?.name).toBe("Ed Editor");
    expect(page.whoDidWhat.find((e) => e.kind === "sent_for_checking")?.onTime).toBe(false);
    expect(page.header.editedBy?.name).toBe("Ed Editor");
  });
});
