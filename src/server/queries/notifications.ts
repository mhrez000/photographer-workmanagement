/**
 * Notification centre reads (ARCHITECTURE.md §6, §10 `/notifications`).
 * Always the actor's own notifications (org-scoped); newest first; keyset
 * cursor over (created_at DESC, id DESC). Writes (mark read) live in
 * src/server/services/notifications.ts.
 */
import { and, desc, eq, isNull, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { jobs, notifications, users } from "@/db/schema";
import type { AuthContext, NotificationView, Paginated } from "@/lib/types";
import { parseInput } from "@/server/services/_shared";
import { unreadCount as serviceUnreadCount } from "@/server/services/notifications";
import { decodeKeysetCursor, encodeKeysetCursor } from "./activity";

export const NOTIFICATIONS_DEFAULT_LIMIT = 30;
export const NOTIFICATIONS_MAX_LIMIT = 200;

const one = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), item);

export const NotificationListSchema = z.object({
  unread: one(
    z.preprocess(
      (v) => (v === undefined ? undefined : typeof v === "boolean" ? v : ["1", "true", "yes"].includes(String(v).toLowerCase())),
      z.boolean().optional(),
    ),
  ),
  cursor: one(z.string().min(1).optional()),
  limit: one(z.coerce.number().int().min(1).max(NOTIFICATIONS_MAX_LIMIT).optional()),
});
export type NotificationListInput = z.input<typeof NotificationListSchema>;

export function listNotifications(db: DbLike, ctx: AuthContext, input: unknown = {}): Paginated<NotificationView> {
  const f = parseInput(NotificationListSchema, input ?? {});
  if (!ctx.userId) return { items: [], nextCursor: null, total: 0 };
  const limit = f.limit ?? NOTIFICATIONS_DEFAULT_LIMIT;
  const parts: (SQL | undefined)[] = [eq(notifications.organisationId, ctx.organisationId), eq(notifications.userId, ctx.userId)];
  if (f.unread) parts.push(isNull(notifications.readAt));
  const cursor = decodeKeysetCursor(f.cursor);
  if (cursor) {
    parts.push(or(lt(notifications.createdAt, cursor.createdAt), and(eq(notifications.createdAt, cursor.createdAt), lt(notifications.id, cursor.id))));
  }
  const rows = db
    .select({
      n: notifications,
      job: { id: jobs.id, jobNumber: jobs.jobNumber, name: jobs.name },
      actor: { id: users.id, name: users.name, role: users.role, avatarColour: users.avatarColour, isActive: users.isActive },
    })
    .from(notifications)
    .leftJoin(jobs, eq(jobs.id, notifications.jobId))
    .leftJoin(users, eq(users.id, notifications.actorUserId))
    .where(and(...parts))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(
      (r): NotificationView => ({
        id: r.n.id,
        type: r.n.type,
        title: r.n.title,
        body: r.n.body,
        linkPath: r.n.linkPath,
        job: r.job ? { ...r.job } : null,
        actor: r.actor ? { ...r.actor } : null,
        readAt: r.n.readAt,
        createdAt: r.n.createdAt,
      }),
    ),
    nextCursor: hasMore && last ? encodeKeysetCursor(last.n.createdAt, last.n.id) : null,
  };
}

/** Unread badge count for the actor (delegates to the notifications service). */
export function unreadCount(db: DbLike, ctx: AuthContext): number {
  return serviceUnreadCount(ctx, db);
}
