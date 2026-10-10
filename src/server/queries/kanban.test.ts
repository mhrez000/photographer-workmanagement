import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { KANBAN_COLUMNS } from "@/lib/constants";
import type { KanbanCard } from "@/lib/types";
import { NotFoundError } from "@/server/errors";
import { getKanbanBoard, previewKanbanDrop } from "./kanban";

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
    expect((await card("manager", inProgress.id))?.allowedColumns).toEqual(["review"]);
    expect((await card("photographer1", inProgress.id))?.allowedColumns).toEqual([]);

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
