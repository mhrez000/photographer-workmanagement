/**
 * Read model for the create-job form (docs/ROLES.md §4.1–§4.3).
 *
 * The default photographer pre-filled for jobs editors create is
 * `organisation_settings.default_photographer_user_id` while it is an active
 * photographer of the organisation, else the primary owner. Only ids are
 * returned: names come from the photographer options the form loads anyway.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { jobTypes, jobs, organisationSettings, users } from "@/db/schema";
import type { AuthContext } from "@/lib/types";
import { assertCan } from "@/server/auth/permissions";

export interface JobFormDefaults {
  /** Photographer pre-filled for editors (and the API default when an editor omits it). */
  defaultPhotographerId: string | null;
  /** The organisation's primary owner (marked "Owner" in pickers). */
  primaryOwnerId: string | null;
}

async function activePhotographer(db: DbLike, ctx: AuthContext, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const row = await first(
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organisationId, ctx.organisationId), eq(users.role, "photographer"), eq(users.isActive, true))),
  );
  return row?.id ?? null;
}

/** `job.create` holders only. */
export async function getJobFormDefaults(db: DbLike, ctx: AuthContext): Promise<JobFormDefaults> {
  assertCan(ctx, "job.create");
  const settings = await first(
    db
      .select({
        defaultPhotographerUserId: organisationSettings.defaultPhotographerUserId,
        primaryOwnerUserId: organisationSettings.primaryOwnerUserId,
      })
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, ctx.organisationId)),
  );
  const primaryOwnerId = settings?.primaryOwnerUserId ?? null;
  const configured = await activePhotographer(db, ctx, settings?.defaultPhotographerUserId ?? null);
  return { defaultPhotographerId: configured ?? (await activePhotographer(db, ctx, primaryOwnerId)), primaryOwnerId };
}

/**
 * "Type of shoot defaults to the last one used" (SIMPLIFICATION-PLAN §5): the job type of the most recent
 * job the viewer created, else the organisation's most recent job, else null (the form then picks the
 * first type). Archived types are skipped so the default is always selectable.
 */
export async function getLastUsedJobTypeId(db: DbLike, ctx: AuthContext): Promise<string | null> {
  assertCan(ctx, "job.create");
  const pick = async (mine: boolean): Promise<string | null> => {
    const row = await first(
      db
        .select({ jobTypeId: jobs.jobTypeId })
        .from(jobs)
        .innerJoin(jobTypes, eq(jobTypes.id, jobs.jobTypeId))
        .where(
          and(
            eq(jobs.organisationId, ctx.organisationId),
            isNull(jobTypes.archivedAt),
            mine && ctx.userId ? eq(jobs.createdByUserId, ctx.userId) : undefined,
          ),
        )
        .orderBy(desc(jobs.createdAt), desc(jobs.id))
        .limit(1),
    );
    return row?.jobTypeId ?? null;
  };
  return (await pick(true)) ?? (await pick(false));
}
