/**
 * Reads of the migration-0004 columns the simplified screens need
 * (docs/SIMPLIFICATION-PLAN.md §7, §8):
 *
 *   organisation_settings.advanced_tools_enabled   (Settings → Studio → Advanced tools)
 *   users.usual_capacity_jobs                      ("Usually handles up to N")
 *   job_types.usual_days_to_edit                   (New job form: due = shoot + N)
 *   users.simpler_notice_dismissed_at              (the one-time "Proofline got simpler" card)
 *
 * Small org-scoped selects shared by Home, Editors, the job page and Settings
 * so every screen reads the same column the same way.
 */
import { and, eq, inArray } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { jobTypes, organisationSettings, users } from "@/db/schema";
import type { AuthContext } from "@/lib/types";

/** `advanced_tools_enabled` for the org (false when the settings row is missing). */
export async function loadAdvancedToolsEnabled(db: DbLike, ctx: AuthContext): Promise<{ enabled: boolean; present: boolean }> {
  const row = await first(
    db.select({ enabled: organisationSettings.advancedToolsEnabled }).from(organisationSettings).where(eq(organisationSettings.organisationId, ctx.organisationId)),
  );
  return { enabled: row?.enabled === true, present: true };
}

/** `users.usual_capacity_jobs` per user id (org-scoped); ids without a value map to null. */
export async function loadUsualCapacities(db: DbLike, ctx: AuthContext, userIds: readonly string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const ids = [...new Set(userIds)];
  for (const id of ids) out.set(id, null);
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: users.id, n: users.usualCapacityJobs })
    .from(users)
    .where(and(eq(users.organisationId, ctx.organisationId), inArray(users.id, ids)));
  for (const r of rows) out.set(r.id, r.n ?? null);
  return out;
}

/** `job_types.usual_days_to_edit` per job type (org-scoped); null when unset. */
export async function loadUsualDaysToEdit(db: DbLike, ctx: AuthContext): Promise<Map<string, number | null>> {
  const rows = await db.select({ id: jobTypes.id, n: jobTypes.usualDaysToEdit }).from(jobTypes).where(eq(jobTypes.organisationId, ctx.organisationId));
  return new Map(rows.map((r) => [r.id, r.n ?? null]));
}

/** `users.simpler_notice_dismissed_at` for the viewer; null = show the card. */
export async function loadSimplerNoticeDismissedAt(db: DbLike, ctx: AuthContext): Promise<string | null> {
  if (ctx.userId === null) return null;
  const row = await first(
    db.select({ at: users.simplerNoticeDismissedAt }).from(users).where(and(eq(users.organisationId, ctx.organisationId), eq(users.id, ctx.userId))),
  );
  return row?.at ?? null;
}
