/**
 * Saved views (ARCHITECTURE.md §2.5 saved_views, §9 `GET /api/views?scope`).
 * A viewer sees their own non-archived views plus every view shared in the
 * organisation. Another user's private view looks missing (404).
 */
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { savedViews } from "@/db/schema";
import { SAVED_VIEW_SCOPES } from "@/lib/constants";
import type { AuthContext, SavedView, SavedViewItem } from "@/lib/types";
import { SavedViewConfigSchema, parseJsonColumn } from "@/lib/validation/json";
import { assertCan } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { loadSavedViewInOrg, parseInput } from "@/server/services/_shared";
import { binaryAsc, loadUserRefs } from "./metrics";

const one = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), item);

export const SavedViewFiltersSchema = z.object({ scope: one(z.enum(SAVED_VIEW_SCOPES).optional()) });

const EMPTY_CONFIG = { filters: {}, sort: [], columns: [] };

function toItem(v: SavedView, ctx: AuthContext, owner: SavedViewItem["owner"] | undefined): SavedViewItem {
  return {
    id: v.id,
    name: v.name,
    scope: v.scope,
    config: parseJsonColumn(SavedViewConfigSchema, v.config, EMPTY_CONFIG),
    isShared: v.isShared,
    isDefault: v.isDefault,
    owner: owner ?? { id: v.ownerUserId, name: "Unknown", role: "editor", avatarColour: "#94a3b8", isActive: false },
    isMine: v.ownerUserId === ctx.userId,
    archivedAt: v.archivedAt,
    version: v.version,
    updatedAt: v.updatedAt,
  };
}

/** `GET /api/views?scope` — own views first, then shared ones, each by name. */
export async function listSavedViews(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<SavedViewItem[]> {
  if (ctx.userId === null) return [];
  assertCan(ctx, "saved_view.manage", { userId: ctx.userId, organisationId: ctx.organisationId });
  const f = parseInput(SavedViewFiltersSchema, input ?? {});
  const rows = await db
    .select()
    .from(savedViews)
    .where(
      and(
        eq(savedViews.organisationId, ctx.organisationId),
        isNull(savedViews.archivedAt),
        or(eq(savedViews.ownerUserId, ctx.userId), eq(savedViews.isShared, true)),
        f.scope ? eq(savedViews.scope, f.scope) : undefined,
      ),
    )
    .orderBy(desc(savedViews.isDefault), binaryAsc(savedViews.name), asc(savedViews.id));
  const owners = await loadUserRefs(
    db,
    ctx,
    rows.map((r) => r.ownerUserId),
  );
  const items = rows.map((r) => toItem(r, ctx, owners.get(r.ownerUserId)));
  return [...items.filter((i) => i.isMine), ...items.filter((i) => !i.isMine)];
}

/** One view (own or shared, not archived); otherwise 404. */
export async function getSavedView(db: DbLike, ctx: AuthContext, viewId: string): Promise<SavedViewItem> {
  const v = await loadSavedViewInOrg(db, ctx, viewId);
  if (v.archivedAt !== null || (v.ownerUserId !== ctx.userId && !v.isShared)) throw new NotFoundError("Saved view");
  return toItem(v, ctx, (await loadUserRefs(db, ctx, [v.ownerUserId])).get(v.ownerUserId));
}
