/**
 * Saved views (ARCHITECTURE.md §2.5 saved_views, §5 saved_view.*).
 * - every user manages their own views (`saved_view.manage`, self)
 * - sharing a view with the organisation needs `saved_view.share`
 *   (owner / manager); holders of that permission may also edit/delete
 *   shared views created by others
 * - `isDefault` marks the owner's default view for a scope (one per
 *   user + scope; setting it unsets the previous one)
 * - delete = archive (no hard deletes)
 */
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import { savedViews } from "@/db/schema";
import type { SavedViewScope } from "@/lib/constants";
import type { AuthContext, SavedView } from "@/lib/types";
import { CreateSavedViewInput, DeleteSavedViewInput, UpdateSavedViewInput } from "@/lib/validation/views";
import { recordEvent } from "@/server/audit";
import { assertCan, can } from "@/server/auth/permissions";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { loadSavedViewInOrg, one, parseInput, type DbLike, type Tx } from "./_shared";
import { checkVersion, jsonEqual, ruleViolation } from "./_admin";

function actorOf(ctx: AuthContext): string {
  if (!ctx.userId || ctx.isSystem) throw new ForbiddenError("saved_view.manage");
  return ctx.userId;
}

/**
 * Someone else's private view does not exist as far as the actor is concerned:
 * 404, exactly like GET /api/views/:id (a 403 would confirm the id exists).
 * Runs before any other check (archived, permission, version).
 */
function assertVisible(ctx: AuthContext, view: SavedView): void {
  if (view.ownerUserId !== ctx.userId && !view.isShared) throw new NotFoundError("Saved view");
}

/**
 * The actor may change this view: their own, or a shared one when they hold
 * saved_view.share. Someone else's private view → 404 (`assertVisible`); a
 * shared view the actor may not change → 403.
 */
function assertCanModify(ctx: AuthContext, view: SavedView): void {
  assertVisible(ctx, view);
  if (view.ownerUserId === ctx.userId && can(ctx, "saved_view.manage", { userId: view.ownerUserId, organisationId: view.organisationId })) return;
  if (view.isShared && can(ctx, "saved_view.share")) return;
  throw new ForbiddenError("saved_view.manage");
}

async function clearDefault(tx: Tx, ctx: AuthContext, ownerUserId: string, scope: SavedViewScope, exceptId: string | null): Promise<void> {
  const rows = await tx
    .select()
    .from(savedViews)
    .where(
      and(
        eq(savedViews.organisationId, ctx.organisationId),
        eq(savedViews.ownerUserId, ownerUserId),
        eq(savedViews.scope, scope),
        eq(savedViews.isDefault, true),
        isNull(savedViews.archivedAt),
        exceptId ? ne(savedViews.id, exceptId) : undefined,
      ),
    )
    .orderBy(asc(savedViews.id));
  for (const r of rows) {
    await tx
      .update(savedViews)
      .set({ isDefault: false, updatedAt: ctx.now(), version: r.version + 1 })
      .where(eq(savedViews.id, r.id));
  }
}

function snapshot(v: SavedView) {
  return { name: v.name, scope: v.scope, config: v.config, isShared: v.isShared, isDefault: v.isDefault };
}

/** The actor's own views plus views shared in the organisation (non-archived), optionally for one scope. */
export async function listSavedViews(db: DbLike, ctx: AuthContext, scope?: SavedViewScope): Promise<SavedView[]> {
  const me = actorOf(ctx);
  return db
    .select()
    .from(savedViews)
    .where(
      and(
        eq(savedViews.organisationId, ctx.organisationId),
        isNull(savedViews.archivedAt),
        or(eq(savedViews.ownerUserId, me), eq(savedViews.isShared, true)),
        scope ? eq(savedViews.scope, scope) : undefined,
      ),
    )
    .orderBy(asc(savedViews.scope), asc(savedViews.name), asc(savedViews.id));
}

export async function createSavedView(tx: Tx, ctx: AuthContext, input: unknown): Promise<SavedView> {
  const me = actorOf(ctx);
  assertCan(ctx, "saved_view.manage", { userId: me, organisationId: ctx.organisationId });
  const data = parseInput(CreateSavedViewInput, input);
  if (data.isShared) assertCan(ctx, "saved_view.share");
  if (data.isDefault) await clearDefault(tx, ctx, me, data.scope, null);
  const now = ctx.now();
  const row = await one(
    tx
      .insert(savedViews)
      .values({
        organisationId: ctx.organisationId,
        ownerUserId: me,
        name: data.name,
        scope: data.scope,
        config: data.config,
        isShared: data.isShared ?? false,
        isDefault: data.isDefault ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "saved_view",
    entityId: row.id,
    eventType: "saved_view.created",
    action: "created",
    previousValue: null,
    newValue: snapshot(row),
    metadata: { viewId: row.id },
  });
  return row;
}

export async function updateSavedView(tx: Tx, ctx: AuthContext, input: unknown): Promise<SavedView> {
  actorOf(ctx);
  const data = parseInput(UpdateSavedViewInput, input);
  const view = await loadSavedViewInOrg(tx, ctx, data.viewId);
  assertVisible(ctx, view);
  if (view.archivedAt) throw ruleViolation("This view was deleted");
  assertCanModify(ctx, view);
  checkVersion(view, data.expectedVersion, view);
  // Sharing or un-sharing is itself a sharing decision.
  if (data.isShared !== undefined && data.isShared !== view.isShared) assertCan(ctx, "saved_view.share");

  const set: Partial<SavedView> = {};
  if (data.name !== undefined && data.name !== view.name) set.name = data.name;
  if (data.config !== undefined && !jsonEqual(data.config, view.config)) set.config = data.config;
  if (data.isShared !== undefined && data.isShared !== view.isShared) set.isShared = data.isShared;
  if (data.isDefault !== undefined && data.isDefault !== view.isDefault) set.isDefault = data.isDefault;
  if (Object.keys(set).length === 0) return view;
  if (set.isDefault) await clearDefault(tx, ctx, view.ownerUserId, view.scope, view.id);

  const row = await one(
    tx
      .update(savedViews)
      .set({ ...set, updatedAt: ctx.now(), version: view.version + 1 })
      .where(eq(savedViews.id, view.id))
      .returning(),
  );
  const prev: Record<string, unknown> = {};
  for (const k of Object.keys(set) as (keyof SavedView)[]) prev[k] = view[k];
  await recordEvent(tx, ctx, {
    entityType: "saved_view",
    entityId: view.id,
    eventType: "saved_view.updated",
    action: "updated",
    previousValue: prev,
    newValue: set,
    metadata: { viewId: view.id, name: row.name, scope: row.scope },
  });
  return row;
}

/** Soft delete (archived_at); audited as saved_view.deleted. */
export async function deleteSavedView(tx: Tx, ctx: AuthContext, input: unknown): Promise<SavedView> {
  actorOf(ctx);
  const data = parseInput(DeleteSavedViewInput, input);
  const view = await loadSavedViewInOrg(tx, ctx, data.viewId);
  assertVisible(ctx, view);
  if (view.archivedAt) throw ruleViolation("This view was already deleted");
  assertCanModify(ctx, view);
  checkVersion(view, data.expectedVersion, view);
  const now = ctx.now();
  const row = await one(
    tx
      .update(savedViews)
      .set({ archivedAt: now, isDefault: false, updatedAt: now, version: view.version + 1 })
      .where(eq(savedViews.id, view.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "saved_view",
    entityId: view.id,
    eventType: "saved_view.deleted",
    action: "archived",
    previousValue: snapshot(view),
    newValue: { archivedAt: now },
    metadata: { viewId: view.id, name: view.name },
  });
  return row;
}
