import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { KANBAN_COLUMNS } from "@/lib/constants";
import type { KanbanCard } from "@/lib/types";
import { NotFoundError } from "@/server/errors";
import { getKanbanBoard, previewKanbanDrop } from "./kanban";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: keyof SeedIds["users"]) => contextFor(db, ids.users[key]);
const job = (opts: JobFixtureOptions) => insertJobFixture(db, ids, opts).job;

function card(key: keyof SeedIds["users"], jobId: string): KanbanCard | undefined {
  return getKanbanBoard(db, ctxOf(key))
    .columns.flatMap((c) => c.cards)
    .find((c) => c.id === jobId);
}

describe("getKanbanBoard", () => {
  it("places cards in the column of their category and counts them", () => {
    job({ statusKey: "new" });
    job({ statusKey: "ready" });
    job({ statusKey: "accepted" });
    job({ statusKey: "in_progress" });
    job({ statusKey: "submitted" });
    job({ statusKey: "resubmitted" });
    job({ statusKey: "revision" });
    job({ statusKey: "delivered" });
    job({ statusKey: "completed" });
    job({ statusKey: "cancelled" });
    const board = getKanbanBoard(db, ctxOf("owner"));
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
    const withCancelled = getKanbanBoard(db, ctxOf("owner"), { includeCancelled: "1" });
    expect(withCancelled.cancelled?.count).toBe(1);
    expect(withCancelled.cancelled?.cards[0].allowedColumns).toEqual(["new"]); // restore → initial status
  });

  it("computes allowedColumns per actor from the workflow edges", () => {
    const inProgress = job({ statusKey: "in_progress", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });
    const submitted = job({ statusKey: "submitted", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });
    const fresh = job({ statusKey: "new", editorId: null, photographerId: ids.users.photographer1 });
    const completed = job({ statusKey: "completed", editorId: ids.users.editor1, photographerId: ids.users.photographer1 });

    expect(card("editor1", inProgress.id)?.allowedColumns).toEqual(["review"]);
    expect(card("manager", inProgress.id)?.allowedColumns).toEqual(["review"]);
    expect(card("photographer1", inProgress.id)?.allowedColumns).toEqual([]);

    expect(card("photographer1", submitted.id)?.allowedColumns).toEqual(["revision", "approved"]);
    expect(card("editor1", submitted.id)?.allowedColumns).toEqual([]);

    // new → assigned only happens through assignment (engine-internal), new → ready stays in the column.
    expect(card("photographer1", fresh.id)?.allowedColumns).toEqual([]);

    expect(card("photographer1", completed.id)?.allowedColumns).toEqual(["in_progress", "revision", "approved"]);
    expect(card("editor1", completed.id)?.allowedColumns).toEqual([]);
  });

  it("is row-scoped by visibility and never shows another organisation's jobs", () => {
    const mine = job({ statusKey: "in_progress", editorId: ids.users.editor1 });
    job({ statusKey: "in_progress", editorId: ids.users.editor2, photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 });
    const other = seedMinimalOrg(db, { slug: "other" });
    insertJobFixture(db, other, { statusKey: "in_progress" });
    const editorBoard = getKanbanBoard(db, ctxOf("editor1"));
    expect(editorBoard.columns.flatMap((c) => c.cards).map((c) => c.id)).toEqual([mine.id]);
    expect(getKanbanBoard(db, ctxOf("owner")).columns.find((c) => c.column === "in_progress")?.count).toBe(2);
  });

  it("honours filters and the per-column limit", () => {
    job({ statusKey: "in_progress", priority: "urgent" });
    job({ statusKey: "in_progress", priority: "low" });
    job({ statusKey: "in_progress", priority: "high" });
    const col = getKanbanBoard(db, ctxOf("owner"), { perColumnLimit: 2 }).columns.find((c) => c.column === "in_progress");
    expect(col?.count).toBe(3);
    expect(col?.cards.map((c) => c.priority)).toEqual(["urgent", "high"]);
    const filtered = getKanbanBoard(db, ctxOf("owner"), { priority: "low" }).columns.find((c) => c.column === "in_progress");
    expect(filtered?.cards.map((c) => c.priority)).toEqual(["low"]);
  });
});

describe("previewKanbanDrop", () => {
  it("mirrors resolveKanbanDrop for the actor and 404s on invisible jobs", () => {
    const j = job({ statusKey: "in_progress", editorId: ids.users.editor1 });
    expect(previewKanbanDrop(db, ctxOf("editor1"), j.id, "review")).toMatchObject({ kind: "single", toStatus: { key: "submitted" } });
    expect(previewKanbanDrop(db, ctxOf("editor1"), j.id, "in_progress")).toEqual({ kind: "noop" });
    expect(previewKanbanDrop(db, ctxOf("editor1"), j.id, "completed").kind).toBe("none");
    expect(() => previewKanbanDrop(db, ctxOf("editor2"), j.id, "review")).toThrow(NotFoundError);
  });
});
