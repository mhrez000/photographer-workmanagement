import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, savedViews } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, systemContextFor, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext, DashboardLayout, SavedViewConfig } from "@/lib/types";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { defaultLayoutFor, getDashboardLayout, putDashboardLayout, resetDashboardLayout } from "./dashboards";
import { createSavedView, deleteSavedView, listSavedViews, updateSavedView } from "./savedViews";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => T): T {
  const ctx = contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

const config: SavedViewConfig = {
  filters: { quick: "overdue", statusCategory: ["in_progress"] },
  sort: [{ column: "dueDate", dir: "asc" }],
  groupBy: "editor",
  columns: ["job", "editor", "status", "dueDate"],
};

describe("saved views", () => {
  it("any user saves private views; sharing needs saved_view.share", () => {
    const mine = run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "My overdue", scope: "all_work", config }));
    expect(mine).toMatchObject({ ownerUserId: ids.users.editor1, isShared: false, isDefault: false });
    expect(() => run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "Shared", scope: "all_work", config, isShared: true }))).toThrow(
      ForbiddenError,
    );
    const shared = run(ids.users.manager, (tx, ctx) => createSavedView(tx, ctx, { name: "Overdue", scope: "all_work", config, isShared: true }));

    // editor2 sees the shared view but not editor1's private one
    const seen = listSavedViews(db, contextFor(db, ids.users.editor2)).map((v) => v.id);
    expect(seen).toEqual([shared.id]);
    expect(listSavedViews(db, contextFor(db, ids.users.editor1), "all_work").map((v) => v.id).sort()).toEqual([mine.id, shared.id].sort());
    expect(db.select().from(activityEvents).where(eq(activityEvents.eventType, "saved_view.created")).all()).toHaveLength(2);
  });

  it("validates the config shape", () => {
    expect(() =>
      run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "Bad", scope: "all_work", config: { ...config, columns: ["nope"] } })),
    ).toThrow(ValidationError);
    expect(() => run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "Bad", scope: "everything", config }))).toThrow(ValidationError);
  });

  it("only the owner edits a private view; managers may edit shared views; others get 403", () => {
    const mine = run(ids.users.photographer1, (tx, ctx) => createSavedView(tx, ctx, { name: "Mine", scope: "jobs", config }));
    expect(() => run(ids.users.photographer2, (tx, ctx) => updateSavedView(tx, ctx, { viewId: mine.id, name: "X" }))).toThrow(ForbiddenError);
    expect(() => run(ids.users.manager, (tx, ctx) => updateSavedView(tx, ctx, { viewId: mine.id, name: "X" }))).toThrow(ForbiddenError);
    const renamed = run(ids.users.photographer1, (tx, ctx) => updateSavedView(tx, ctx, { viewId: mine.id, name: "Mine v2", expectedVersion: 1 }));
    expect(renamed).toMatchObject({ name: "Mine v2", version: 2 });
    expect(() => run(ids.users.photographer1, (tx, ctx) => updateSavedView(tx, ctx, { viewId: mine.id, isShared: true }))).toThrow(ForbiddenError);
    expect(() => run(ids.users.photographer1, (tx, ctx) => updateSavedView(tx, ctx, { viewId: mine.id, name: "Z", expectedVersion: 1 }))).toThrow(
      ConflictError,
    );

    const shared = run(ids.users.owner, (tx, ctx) => createSavedView(tx, ctx, { name: "Team", scope: "kanban", config, isShared: true }));
    expect(run(ids.users.manager, (tx, ctx) => updateSavedView(tx, ctx, { viewId: shared.id, name: "Team board" })).name).toBe("Team board");
  });

  it("one default per user and scope", () => {
    const a = run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "A", scope: "my_work", config, isDefault: true }));
    const b = run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "B", scope: "my_work", config, isDefault: true }));
    const other = run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "C", scope: "calendar", config, isDefault: true }));
    const rows = new Map(db.select().from(savedViews).all().map((r) => [r.id, r.isDefault]));
    expect(rows.get(a.id)).toBe(false);
    expect(rows.get(b.id)).toBe(true);
    expect(rows.get(other.id)).toBe(true);
    run(ids.users.editor1, (tx, ctx) => updateSavedView(tx, ctx, { viewId: a.id, isDefault: true }));
    expect(db.select().from(savedViews).where(eq(savedViews.id, b.id)).get()?.isDefault).toBe(false);
  });

  it("delete archives the view; foreign ids are 404; the system context cannot save views", () => {
    const v = run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "Temp", scope: "all_work", config }));
    const deleted = run(ids.users.editor1, (tx, ctx) => deleteSavedView(tx, ctx, { viewId: v.id }));
    expect(deleted.archivedAt).not.toBeNull();
    expect(listSavedViews(db, contextFor(db, ids.users.editor1))).toHaveLength(0);
    expect(db.select().from(savedViews).all()).toHaveLength(1);
    expect(db.select().from(activityEvents).where(eq(activityEvents.eventType, "saved_view.deleted")).all()).toHaveLength(1);

    const other = seedMinimalOrg(db, { slug: "other" });
    const foreign = withTx((tx) => createSavedView(tx, contextFor(db, other.users.editor1), { name: "F", scope: "all_work", config }), { db });
    expect(() => run(ids.users.owner, (tx, ctx) => updateSavedView(tx, ctx, { viewId: foreign.id, name: "X" }))).toThrow(NotFoundError);
    expect(() =>
      withTx((tx) => createSavedView(tx, systemContextFor(db, ids.organisationId), { name: "S", scope: "all_work", config }), { db }),
    ).toThrow(ForbiddenError);
  });
});

describe("dashboard layouts", () => {
  it("returns the role default until a layout is saved", () => {
    const view = getDashboardLayout(db, contextFor(db, ids.users.editor1));
    expect(view).toMatchObject({ isDefault: true, version: 0 });
    expect(view.layout.widgets.map((w) => w.type)).toEqual(defaultLayoutFor("editor").widgets.map((w) => w.type));
    expect(getDashboardLayout(db, contextFor(db, ids.users.owner)).layout.widgets.some((w) => w.type === "editor_performance")).toBe(true);
  });

  it("saves (upsert) with version checks and an audit event", () => {
    const layout: DashboardLayout = {
      widgets: [
        { id: "a", type: "my_workload", x: 0, y: 0, w: 6, h: 3 },
        { id: "b", type: "due_today", x: 6, y: 0, w: 6, h: 3, settings: { limit: 5 } },
      ],
    };
    const saved = run(ids.users.editor1, (tx, ctx) => putDashboardLayout(tx, ctx, { layout, expectedVersion: 0 }));
    expect(saved).toMatchObject({ version: 1, isDefault: false });
    expect(getDashboardLayout(db, contextFor(db, ids.users.editor1)).layout).toEqual(layout);
    expect(() => run(ids.users.editor1, (tx, ctx) => putDashboardLayout(tx, ctx, { layout, expectedVersion: 0 }))).toThrow(ConflictError);
    const again = run(ids.users.editor1, (tx, ctx) => putDashboardLayout(tx, ctx, { layout: { widgets: [layout.widgets[0]] }, expectedVersion: 1 }));
    expect(again.version).toBe(2);
    const events = db.select().from(activityEvents).where(eq(activityEvents.eventType, "dashboard.updated")).all();
    expect(events).toHaveLength(2);
    expect(events[1].previousValue).toEqual({ layout });

    const reset = run(ids.users.editor1, (tx, ctx) => resetDashboardLayout(tx, ctx));
    expect(reset.layout.widgets.map((w) => w.type)).toEqual(defaultLayoutFor("editor").widgets.map((w) => w.type));
  });

  it("rejects widgets the role cannot see, duplicate ids and bad geometry", () => {
    expect(() =>
      run(ids.users.editor1, (tx, ctx) =>
        putDashboardLayout(tx, ctx, { layout: { widgets: [{ id: "x", type: "editor_performance", x: 0, y: 0, w: 4, h: 2 }] } }),
      ),
    ).toThrow(/not available/);
    expect(() =>
      run(ids.users.owner, (tx, ctx) =>
        putDashboardLayout(tx, ctx, {
          layout: {
            widgets: [
              { id: "x", type: "kpis", x: 0, y: 0, w: 4, h: 2 },
              { id: "x", type: "overdue", x: 4, y: 0, w: 4, h: 2 },
            ],
          },
        }),
      ),
    ).toThrow(/unique/);
    expect(() =>
      run(ids.users.owner, (tx, ctx) => putDashboardLayout(tx, ctx, { layout: { widgets: [{ id: "x", type: "kpis", x: 0, y: 0, w: 13, h: 2 }] } })),
    ).toThrow(ValidationError);
  });
});
