import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, setUserFlags, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { KANBAN_COLUMNS } from "@/lib/constants";
import type { KanbanCard } from "@/lib/types";
import { NotFoundError } from "@/server/errors";
import { STAGE_TABS } from "@/lib/stages";
import { ForbiddenError } from "@/server/errors";
import { getKanbanBoard, getStageBoard, previewKanbanDrop } from "./kanban";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(async () => fakeClock.reset());

const ctxOf = async (key: keyof SeedIds["users"]) => await contextFor(db, ids.users[key]);
const job = async (opts: JobFixtureOptions) => (await insertJobFixture(db, ids, opts)).job;

async function card(key: keyof SeedIds["users"], jobId: string): Promise<KanbanCard | undefined> {
  return (await getKanbanBoard(db, await ctxOf(key))).columns.flatMap((c) => c.cards).find((c) => c.id === jobId);
}

describe("getKanbanBoard", () => {
  it("places cards in the column of their category and counts them", async () => {
    await job({ statusKey: "new" });
    await job({ statusKey: "ready" });
    await job({ statusKey: "accepted" });
    await job({ statusKey: "in_progress" });
    await job({ statusKey: "submitted" });
    await job({ statusKey: "resubmitted" });
    await job({ statusKey: "revision" });
    await job({ statusKey: "delivered" });
    await job({ statusKey: "completed" });
    await job({ statusKey: "cancelled" });
    const board = await getKanbanBoard(db, await ctxOf("owner"));
    expect(board.columns.map((c) => c.column)).toEqual([...KANBAN_COLUMNS]);
    expect(Object.fromEntries(board.columns.map((c) => [c.column, c.count]))).toEqual({
      new: 2,
      assigned: 1,
      in_progress: 1,
      review: 2,
      revision: 1,
      approved: 1,
      completed: 1,
    });
    expect(board.cancelled).toBeNull();
    const withCancelled = await getKanbanBoard(db, await ctxOf("owner"), { includeCancelled: "1" });
    expect(withCancelled.cancelled?.count).toBe(1);
    expect(withCancelled.cancelled?.cards[0].allowedColumns).toEqual(["new"]); // restore → initial status
  });

  it("computes allowedColumns per actor from the workflow edges", async () => {
    const inProgress = await job({ statusKey: "in_progress", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });
    const submitted = await job({ statusKey: "submitted", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });
    const fresh = await job({ statusKey: "new", editorId: null, photographerId: ids.users.photographer1 });
    const completed = await job({ statusKey: "completed", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });

    expect((await card("editor1", inProgress.id))?.allowedColumns).toEqual(["review"]);
    // Admins: submit on behalf, or unassign through the "Unassign" edge (job.assign_editor, docs/ROLES.md §5.2).
    expect((await card("coAdmin", inProgress.id))?.allowedColumns).toEqual(["new", "review"]);
    // photographer1 manages the job and has Assign editors: may unassign too; a member without it may not (below).
    expect((await card("photographer1", inProgress.id))?.allowedColumns).toEqual(["new"]);
    await setUserFlags(db, ids.users.photographer1, { canAssignEditors: false });
    expect((await card("photographer1", inProgress.id))?.allowedColumns).toEqual([]);
    await setUserFlags(db, ids.users.photographer1, { canAssignEditors: true });

    expect((await card("photographer1", submitted.id))?.allowedColumns).toEqual(["revision", "approved"]);
    expect((await card("editor1", submitted.id))?.allowedColumns).toEqual([]);

    // new → assigned only happens through assignment (engine-internal), new → ready stays in the column.
    expect((await card("photographer1", fresh.id))?.allowedColumns).toEqual([]);

    expect((await card("photographer1", completed.id))?.allowedColumns).toEqual(["in_progress", "revision", "approved"]);
    expect((await card("editor1", completed.id))?.allowedColumns).toEqual([]);
  });

  it("is row-scoped by visibility and never shows another organisation's jobs", async () => {
    const mine = await job({ statusKey: "in_progress", editorId: ids.users.editor1 });
    await job({ statusKey: "in_progress", editorId: ids.users.editor2, photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 });
    const other = await seedMinimalOrg(db, { slug: "other" });
    await insertJobFixture(db, other, { statusKey: "in_progress" });
    const editorBoard = await getKanbanBoard(db, await ctxOf("editor1"));
    expect(editorBoard.columns.flatMap((c) => c.cards).map((c) => c.id)).toEqual([mine.id]);
    expect((await getKanbanBoard(db, await ctxOf("owner"))).columns.find((c) => c.column === "in_progress")?.count).toBe(2);
  });

  it("honours filters and the per-column limit", async () => {
    await job({ statusKey: "in_progress", priority: "urgent" });
    await job({ statusKey: "in_progress", priority: "low" });
    await job({ statusKey: "in_progress", priority: "high" });
    const col = (await getKanbanBoard(db, await ctxOf("owner"), { perColumnLimit: 2 })).columns.find((c) => c.column === "in_progress");
    expect(col?.count).toBe(3);
    expect(col?.cards.map((c) => c.priority)).toEqual(["urgent", "high"]);
    const filtered = (await getKanbanBoard(db, await ctxOf("owner"), { priority: "low" })).columns.find((c) => c.column === "in_progress");
    expect(filtered?.cards.map((c) => c.priority)).toEqual(["low"]);
  });
});

describe("previewKanbanDrop", () => {
  it("mirrors resolveKanbanDrop for the actor and 404s on invisible jobs", async () => {
    const j = await job({ statusKey: "in_progress", editorId: ids.users.editor1 });
    expect(await previewKanbanDrop(db, await ctxOf("editor1"), j.id, "review")).toMatchObject({ kind: "single", toStatus: { key: "submitted" } });
    expect(await previewKanbanDrop(db, await ctxOf("editor1"), j.id, "in_progress")).toEqual({ kind: "noop" });
    expect((await previewKanbanDrop(db, await ctxOf("editor1"), j.id, "completed")).kind).toBe("none");
    await expect(previewKanbanDrop(db, await ctxOf("editor2"), j.id, "review")).rejects.toThrow(NotFoundError);
  });
});

describe("getKanbanBoard — view scope and client isolation", () => {
  it("scope mine = the owner's shoots; members without See all jobs and editors ignore it; clients see an empty board", async () => {
    const own = await job({ statusKey: "in_progress", photographerId: ids.users.owner, createdByUserId: ids.users.owner });
    const forP2 = await job({ statusKey: "in_progress", photographerId: ids.users.photographer2, createdByUserId: ids.users.owner });
    await job({ statusKey: "delivered", sharedWithClient: true });
    const owner = await ctxOf("owner");
    const ids_ = (b: Awaited<ReturnType<typeof getKanbanBoard>>) => b.columns.flatMap((c) => c.cards).map((c) => c.id).sort();
    const business = await getKanbanBoard(db, owner);
    expect(business.scope).toBe("business");
    expect(ids_(business)).toEqual(expect.arrayContaining([own.id, forP2.id]));
    const mine = await getKanbanBoard(db, owner, { scope: "mine" });
    expect(mine.scope).toBe("mine");
    expect(ids_(mine)).toEqual([own.id]);
    expect(mine.columns.find((c) => c.column === "in_progress")?.count).toBe(1);
    expect(ids_(await getKanbanBoard(db, owner, {}, { scopeCookie: "mine" }))).toEqual([own.id]);
    expect(ids_(await getKanbanBoard(db, owner, { scope: "business" }, { scopeCookie: "mine" }))).toEqual(ids_(business));

    const p2 = await ctxOf("photographer2");
    expect(ids_(await getKanbanBoard(db, p2, { scope: "business" }))).toEqual(ids_(await getKanbanBoard(db, p2)));
    expect((await getKanbanBoard(db, p2, { scope: "mine" })).scope).toBeNull();
    const e1 = await ctxOf("editor1");
    expect(ids_(await getKanbanBoard(db, e1, { scope: "business" }))).toEqual(ids_(await getKanbanBoard(db, e1)));

    const client = await getKanbanBoard(db, await ctxOf("client"), { includeCancelled: "1" });
    expect(client.columns.every((c) => c.count === 0 && c.cards.length === 0)).toBe(true);
    expect(client.cancelled?.count).toBe(0);
    await expect(previewKanbanDrop(db, await ctxOf("client"), own.id, "review")).rejects.toThrow(NotFoundError);
  });
});

describe("getStageBoard — the Board in the five stages (plan §8 follow-up)", () => {
  const cardOf = async (key: keyof SeedIds["users"], jobId: string, input: Record<string, unknown> = {}) => {
    const board = await getStageBoard(db, await ctxOf(key), input);
    return [...board.columns, ...(board.cancelled ? [board.cancelled] : [])].flatMap((c) => c.cards).find((c) => c.job.id === jobId);
  };

  it("has one column per stage tab, counts every category of the stage, and hides Cancelled behind showCancelled", async () => {
    await job({ statusKey: "new" });
    await job({ statusKey: "ready" });
    await job({ statusKey: "accepted" });
    await job({ statusKey: "in_progress" });
    await job({ statusKey: "submitted" });
    await job({ statusKey: "resubmitted" });
    await job({ statusKey: "revision" });
    await job({ statusKey: "approved" });
    await job({ statusKey: "delivered" });
    await job({ statusKey: "completed" });
    await job({ statusKey: "cancelled" });
    const board = await getStageBoard(db, await ctxOf("owner"));
    expect(board.columns.map((c) => c.stage)).toEqual([...STAGE_TABS]);
    expect(Object.fromEntries(board.columns.map((c) => [c.stage, c.count]))).toEqual({
      needs_editor: 2,
      with_editor: 2,
      ready_to_check: 2,
      changes_asked: 1,
      done: 3,
    });
    expect(board.cancelled).toBeNull();
    expect(board.viewerId).toBe(ids.users.owner);
    const withCancelled = await getStageBoard(db, await ctxOf("owner"), { showCancelled: "1" });
    expect(withCancelled.cancelled?.count).toBe(1);
    expect(withCancelled.cancelled?.cards[0].moves).toEqual([]); // restored from the job page, never by a drop
  });

  it("offers each viewer exactly the drops that are their own simple buttons", async () => {
    const fresh = await job({ statusKey: "new", editorId: null, photographerId: ids.users.photographer1 });
    const notStarted = await job({ statusKey: "assigned", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });
    const editing = await job({ statusKey: "in_progress", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });
    const sent = await job({ statusKey: "submitted", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });
    const changes = await job({ statusKey: "revision", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });
    const finished = await job({ statusKey: "completed", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });

    // Owner: Assign editor · Approve / Ask for changes · Reopen.
    expect((await cardOf("owner", fresh.id))?.moves).toEqual([{ to: "with_editor", action: "assign" }]);
    expect((await cardOf("owner", notStarted.id))?.moves).toEqual([]);
    expect((await cardOf("owner", editing.id))?.moves).toEqual([]);
    expect((await cardOf("owner", sent.id))?.moves).toEqual([
      { to: "done", action: "approve" },
      { to: "changes_asked", action: "ask_for_changes" },
    ]);
    expect((await cardOf("owner", changes.id))?.moves).toEqual([]);
    expect((await cardOf("owner", finished.id))?.moves).toEqual([{ to: "changes_asked", action: "reopen" }]);

    // The editor who has the job: Send for checking from With editor (started or not) and Changes asked; nothing else.
    expect((await cardOf("editor1", notStarted.id))?.moves).toEqual([{ to: "ready_to_check", action: "send_for_checking" }]);
    expect((await cardOf("editor1", editing.id))?.moves).toEqual([{ to: "ready_to_check", action: "send_for_checking" }]);
    expect((await cardOf("editor1", changes.id))?.moves).toEqual([{ to: "ready_to_check", action: "send_for_checking" }]);
    expect((await cardOf("editor1", sent.id))?.moves).toEqual([]);
    expect((await cardOf("editor1", finished.id))?.moves).toEqual([]);
    expect(await cardOf("editor1", fresh.id)).toBeUndefined(); // not theirs: not on their board at all

    // The photographer who manages the job follows their switches: Assign editors / Review submissions.
    expect((await cardOf("photographer1", fresh.id))?.moves).toEqual([{ to: "with_editor", action: "assign" }]);
    expect((await cardOf("photographer1", sent.id))?.moves).toEqual([
      { to: "done", action: "approve" },
      { to: "changes_asked", action: "ask_for_changes" },
    ]);
    await setUserFlags(db, ids.users.photographer1, { canAssignEditors: false, canReviewSubmissions: false });
    expect((await cardOf("photographer1", fresh.id))?.moves).toEqual([]);
    expect((await cardOf("photographer1", sent.id))?.moves).toEqual([]);
    await setUserFlags(db, ids.users.photographer1, { canAssignEditors: true, canReviewSubmissions: true });
  });

  it("marks the Approve drop's share question (portal client) and the owner's self-check confirm", async () => {
    const forPortalClient = await job({ statusKey: "submitted", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });
    const ownEdit = await job({ statusKey: "submitted", editorId: ids.users.owner, photographerId: ids.users.photographer1 });
    const portalCard = await cardOf("owner", forPortalClient.id);
    expect(portalCard?.shareQuestion).toBe(true);
    expect(portalCard?.selfReviewNeedsConfirm).toBe(false);
    const ownCard = await cardOf("owner", ownEdit.id);
    expect(ownCard?.moves.map((m) => m.action)).toEqual(["approve", "ask_for_changes"]);
    expect(ownCard?.selfReviewNeedsConfirm).toBe(true);
    // Flags are only computed where Approve is a drop: a card the viewer cannot check carries neither.
    const editorView = await cardOf("editor1", forPortalClient.id);
    expect(editorView?.shareQuestion).toBe(false);
    expect(editorView?.selfReviewNeedsConfirm).toBe(false);
  });

  it("applies the Jobs filters and the per-column cap, and refuses clients", async () => {
    await job({ statusKey: "in_progress", editorId: ids.users.editor1, dueDate: "2026-10-01T13:59:59.999Z" });
    await job({ statusKey: "in_progress", editorId: ids.users.editor2, dueDate: "2026-10-20T13:59:59.999Z" });
    await job({ statusKey: "in_progress", editorId: ids.users.editor2 });
    const owner = await ctxOf("owner");
    const col = (b: Awaited<ReturnType<typeof getStageBoard>>) => b.columns.find((c) => c.stage === "with_editor");
    expect(col(await getStageBoard(db, owner))?.count).toBe(3);
    const capped = col(await getStageBoard(db, owner, { perColumnLimit: 2 }));
    expect(capped?.count).toBe(3);
    expect(capped?.cards).toHaveLength(2);
    expect(col(await getStageBoard(db, owner, { late: "1" }))?.count).toBe(1);
    expect(col(await getStageBoard(db, owner, { editorId: ids.users.editor2 }))?.count).toBe(2);
    await expect(getStageBoard(db, await ctxOf("client"))).rejects.toThrow(ForbiddenError);
  });
});
