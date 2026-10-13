/**
 * Settings views (ARCHITECTURE.md §10 `/settings/organisation`,
 * `/settings/roles`, `/settings/notifications`).
 */
import { and, eq } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { organisations, userNotificationPrefs } from "@/db/schema";
import { CLIENT_NOTIFICATION_TYPES, NOTIFICATION_TYPES, NOTIFICATION_TYPE_META } from "@/lib/constants";
import type { AuthContext, NotificationPrefView, PermissionMatrixRow, SettingsView } from "@/lib/types";
import { assertCan, can, permissionMatrix } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { loadOrgSettings } from "./metrics";

/** `GET /api/settings` (settings.view = O/M; `canManage` = settings.manage = owner). */
export async function getSettingsView(db: DbLike, ctx: AuthContext): Promise<SettingsView> {
  assertCan(ctx, "settings.view");
  const org = await first(
    db.select({ id: organisations.id, name: organisations.name, slug: organisations.slug }).from(organisations).where(eq(organisations.id, ctx.organisationId)),
  );
  if (!org) throw new NotFoundError("Organisation");
  return { organisation: org, settings: await loadOrgSettings(db, ctx), canManage: can(ctx, "settings.manage") };
}

/** `GET /api/settings/permissions` — the Roles page matrix (settings.view). Pure (no DB read), so it stays synchronous. */
export function getPermissionMatrix(ctx: AuthContext): PermissionMatrixRow[] {
  assertCan(ctx, "settings.view");
  return permissionMatrix();
}

/**
 * `GET /api/users/:me/notification-prefs` view: every type the actor can
 * receive with its effective toggle (missing row = enabled). Staff never see
 * the client types; client users only the client types (docs/ROLES.md §6.2).
 */
export async function getNotificationPrefs(db: DbLike, ctx: AuthContext): Promise<NotificationPrefView[]> {
  if (ctx.userId === null) return [];
  assertCan(ctx, "notification.prefs", { userId: ctx.userId, organisationId: ctx.organisationId });
  const rows = await db
    .select({ type: userNotificationPrefs.type, enabled: userNotificationPrefs.enabled })
    .from(userNotificationPrefs)
    .where(and(eq(userNotificationPrefs.organisationId, ctx.organisationId), eq(userNotificationPrefs.userId, ctx.userId)));
  const byType = new Map(rows.map((r) => [r.type, r.enabled]));
  const clientTypes: readonly string[] = CLIENT_NOTIFICATION_TYPES;
  const forClient = ctx.role === "client";
  return NOTIFICATION_TYPES.filter((type) => clientTypes.includes(type) === forClient).map((type) => {
    const meta = NOTIFICATION_TYPE_META[type];
    // No row → the type's default (plan §8: 8 groups on, the rest off; portal types on), exactly as `notify` decides.
    const defaultOn = meta.defaultOn || forClient;
    return { type, label: meta.label, mandatory: meta.mandatory, enabled: meta.mandatory ? true : (byType.get(type) ?? defaultOn) };
  });
}
