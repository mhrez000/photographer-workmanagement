import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, savedViews } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, systemContextFor, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext, DashboardLayout, SavedViewConfig } from "@/lib/types";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { defaultLayoutFor, getDashboardLayout, putDashboardLayout, resetDashboardLayout } from "./dashboards";
import { createSavedView, deleteSavedView, listSavedViews, updateSavedView } from "./savedViews";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

async function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> {
  const ctx = await contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

const config: SavedViewConfig = {
  filters: { quick: "overdue", statusCategory: ["in_progress"] },
  sort: [{ column: "dueDate", dir: "asc" }],
  groupBy: "editor",
  columns: ["job", "editor", "status", "dueDate"],
};

describe("saved views", () => {
  it("any user saves private views; sharing needs saved_view.share", async () => {
    const mine = await run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "My overdue", scope: "all_work", config }));
    expect(mine).toMatchObject({ ownerUserId: ids.users.editor1, isShared: false, isDefault: false });
    await expect(run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "Shared", scope: "all_work", config, isShared: true }))).rejects.toThrow(
      ForbiddenError,
    );
    const shared = await run(ids.users.manager, (tx, ctx) => createSavedView(tx, ctx, { name: "Overdue", scope: "all_work", config, isShared: true }));

    // editor2 sees the shared view but not editor1's private one
    const seen = (await listSavedViews(db, await contextFor(db, ids.users.editor2))).map((v) => v.id);
    expect(seen).toEqual([shared.id]);
    expect((await listSavedViews(db, await contextFor(db, ids.users.editor1), "all_work")).map((v) => v.id).sort()).toEqual([mine.id, shared.id].sort());
    expect(await db.select().from(activityEvents).where(eq(activityEvents.eventType, "saved_view.created")).orderBy(activityEvents.rowid)).toHaveLength(2);
  });

  it("validates the config shape", async () => {
    await expect(
      run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "Bad", scope: "all_work", config: { ...config, columns: ["nope"] } })),
    ).rejects.toThrow(ValidationError);
    await expect(run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "Bad", scope: "everything", config }))).rejects.toThrow(ValidationError);
  });

  it("only the owner edits a private view (others: 404, like GET); managers may edit shared views; others get 403 on shared", async () => {
    const mine = await run(ids.users.photographer1, (tx, ctx) => createSavedView(tx, ctx, { name: "Mine", scope: "jobs", config }));
    // Someone else's private view is invisible: PATCH/DELETE answer 404 (not 403, which would confirm the id exists).
    await expect(run(ids.users.photographer2, (tx, ctx) => updateSavedView(tx, ctx, { viewId: mine.id, name: "X" }))).rejects.toThrow(NotFoundError);
    await expect(run(ids.users.manager, (tx, ctx) => updateSavedView(tx, ctx, { viewId: mine.id, name: "X" }))).rejects.toThrow(NotFoundError);
    await expect(run(ids.users.editor1, (tx, ctx) => deleteSavedView(tx, ctx, { viewId: mine.id }))).rejects.toThrow(NotFoundError);
    const renamed = await run(ids.users.photographer1, (tx, ctx) => updateSavedView(tx, ctx, { viewId: mine.id, name: "Mine v2", expectedVersion: 1 }));
    expect(renamed).toMatchObject({ name: "Mine v2", version: 2 });
    await expect(run(ids.users.photographer1, (tx, ctx) => updateSavedView(tx, ctx, { viewId: mine.id, isShared: true }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.photographer1, (tx, ctx) => updateSavedView(tx, ctx, { viewId: mine.id, name: "Z", expectedVersion: 1 }))).rejects.toThrow(
      ConflictError,
    );

    const shared = await run(ids.users.owner, (tx, ctx) => createSavedView(tx, ctx, { name: "Team", scope: "kanban", config, isShared: true }));
    expect((await run(ids.users.manager, (tx, ctx) => updateSavedView(tx, ctx, { viewId: shared.id, name: "Team board" }))).name).toBe("Team board");
    // A shared view is visible to everyone, so a non-manager gets a real 403.
    await expect(run(ids.users.editor1, (tx, ctx) => updateSavedView(tx, ctx, { viewId: shared.id, name: "Mine now" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.editor1, (tx, ctx) => deleteSavedView(tx, ctx, { viewId: shared.id }))).rejects.toThrow(ForbiddenError);

    // An archived private view of someone else is still a 404 (not "This view was deleted").
    await run(ids.users.photographer1, (tx, ctx) => deleteSavedView(tx, ctx, { viewId: mine.id }));
    await expect(run(ids.users.photographer2, (tx, ctx) => updateSavedView(tx, ctx, { viewId: mine.id, name: "X" }))).rejects.toThrow(NotFoundError);
  });

  it("one default per user and scope", async () => {
    const a = await run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "A", scope: "my_work", config, isDefault: true }));
    const b = await run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "B", scope: "my_work", config, isDefault: true }));
    const other = await run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "C", scope: "calendar", config, isDefault: true }));
    const rows = new Map((await db.select().from(savedViews)).map((r) => [r.id, r.isDefault]));
    expect(rows.get(a.id)).toBe(false);
    expect(rows.get(b.id)).toBe(true);
    expect(rows.get(other.id)).toBe(true);
    await run(ids.users.editor1, (tx, ctx) => updateSavedView(tx, ctx, { viewId: a.id, isDefault: true }));
    expect((await first(db.select().from(savedViews).where(eq(savedViews.id, b.id))))?.isDefault).toBe(false);
  });

  it("delete archives the view; foreign ids are 404; the system context cannot save views", async () => {
    const v = await run(ids.users.editor1, (tx, ctx) => createSavedView(tx, ctx, { name: "Temp", scope: "all_work", config }));
    const deleted = await run(ids.users.editor1, (tx, ctx) => deleteSavedView(tx, ctx, { viewId: v.id }));
    expect(deleted.archivedAt).not.toBeNull();
    expect(await listSavedViews(db, await contextFor(db, ids.users.editor1))).toHaveLength(0);
    expect(await db.select().from(savedViews)).toHaveLength(1);
    expect(await db.select().from(activityEvents).where(eq(activityEvents.eventType, "saved_view.deleted")).orderBy(activityEvents.rowid)).toHaveLength(1);

    const other = await seedMinimalOrg(db, { slug: "other" });
    const otherCtx = await contextFor(db, other.users.editor1);
    const foreign = await withTx((tx) => createSavedView(tx, otherCtx, { name: "F", scope: "all_work", config }), { db });
    await expect(run(ids.users.owner, (tx, ctx) => updateSavedView(tx, ctx, { viewId: foreign.id, name: "X" }))).rejects.toThrow(NotFoundError);
    const sysCtx = await systemContextFor(db, ids.organisationId);
    await expect(withTx((tx) => createSavedView(tx, sysCtx, { name: "S", scope: "all_work", config }), { db })).rejects.toThrow(ForbiddenError);
  });
});

describe("dashboard layouts", () => {
  it("returns the role default until a layout is saved", async () => {
    const view = await getDashboardLayout(db, await contextFor(db, ids.users.editor1));
    expect(view).toMatchObject({ isDefault: true, version: 0 });
    expect(view.layout.widgets.map((w) => w.type)).toEqual(defaultLayoutFor("editor").widgets.map((w) => w.type));
    expect((await getDashboardLayout(db, await contextFor(db, ids.users.owner))).layout.widgets.some((w) => w.type === "editor_performance")).toBe(true);
  });

  it("saves (upsert) with version checks and an audit event", async () => {
    const layout: DashboardLayout = {
      widgets: [
        { id: "a", type: "my_workload", x: 0, y: 0, w: 6, h: 3 },
        { id: "b", type: "due_today", x: 6, y: 0, w: 6, h: 3, settings: { limit: 5 } },
      ],
    };
    const saved = await run(ids.users.editor1, (tx, ctx) => putDashboardLayout(tx, ctx, { layout, expectedVersion: 0 }));
    expect(saved).toMatchObject({ version: 1, isDefault: false });
    expect((await getDashboardLayout(db, await contextFor(db, ids.users.editor1))).layout).toEqual(layout);
    await expect(run(ids.users.editor1, (tx, ctx) => putDashboardLayout(tx, ctx, { layout, expectedVersion: 0 }))).rejects.toThrow(ConflictError);
    const again = await run(ids.users.editor1, (tx, ctx) => putDashboardLayout(tx, ctx, { layout: { widgets: [layout.widgets[0]] }, expectedVersion: 1 }));
    expect(again.version).toBe(2);
    const events = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "dashboard.updated")).orderBy(activityEvents.rowid);
    expect(events).toHaveLength(2);
    expect(events[1].previousValue).toEqual({ layout });

    const reset = await run(ids.users.editor1, (tx, ctx) => resetDashboardLayout(tx, ctx));
    expect(reset.layout.widgets.map((w) => w.type)).toEqual(defaultLayoutFor("editor").widgets.map((w) => w.type));
  });

  it("rejects widgets the role cannot see, duplicate ids and bad geometry", async () => {
    await expect(
      run(ids.users.editor1, (tx, ctx) =>
        putDashboardLayout(tx, ctx, { layout: { widgets: [{ id: "x", type: "editor_performance", x: 0, y: 0, w: 4, h: 2 }] } }),
      ),
    ).rejects.toThrow(/not available/);
    await expect(
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
    ).rejects.toThrow(/unique/);
    await expect(
      run(ids.users.owner, (tx, ctx) => putDashboardLayout(tx, ctx, { layout: { widgets: [{ id: "x", type: "kpis", x: 0, y: 0, w: 13, h: 2 }] } })),
    ).rejects.toThrow(ValidationError);
  });
});
