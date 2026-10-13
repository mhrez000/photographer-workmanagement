/**
 * Small reads for Settings → My account (docs/SIMPLIFICATION-PLAN.md §8).
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { notifications } from "@/db/schema";
import { DEFAULT_OFF_NOTIFICATION_TYPES } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { assertCan } from "@/server/auth/permissions";

/** The viewer's unread notices of the types that are now off by default ("Mark old updates as read"). */
export async function countOldUnreadNotifications(db: DbLike, ctx: AuthContext): Promise<number> {
  const userId = ctx.userId;
  if (!userId) return 0;
  assertCan(ctx, "notification.read", { userId, organisationId: ctx.organisationId });
  const row = await first(
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.organisationId, ctx.organisationId),
          isNull(notifications.readAt),
          inArray(notifications.type, [...DEFAULT_OFF_NOTIFICATION_TYPES]),
        ),
      ),
  );
  return row?.n ?? 0;
}
