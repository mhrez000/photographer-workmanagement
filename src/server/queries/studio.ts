/**
 * Small reads for Settings → Studio (docs/SIMPLIFICATION-PLAN.md §8, §9).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { jobs } from "@/db/schema";
import type { AuthContext } from "@/lib/types";
import { assertCan } from "@/server/auth/permissions";

/**
 * Jobs sitting at Approved or Delivered: finished on screen ("Done") but never closed. The optional,
 * owner-confirmed "Close delivered jobs" button completes them one by one (plan §9).
 */
export async function countDeliveredNotClosed(db: DbLike, ctx: AuthContext): Promise<number> {
  assertCan(ctx, "settings.view");
  const row = await first(
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(and(eq(jobs.organisationId, ctx.organisationId), inArray(jobs.statusCategory, ["approved", "delivered"]))),
  );
  return row?.n ?? 0;
}
