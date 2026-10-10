/**
 * Full JobPermissionRef loader (docs/ROLES.md §2.1) — one query per job:
 * the job row, its project's sharing flag, every editor who ever held it
 * (self-review rule + `past` scope) and `draftClosed`:
 *
 *   draftClosed = jobs.started_at IS NOT NULL                                   -- ever started
 *     OR EXISTS (editor assignment ended by someone other than that editor)       -- removed by an admin/member/system
 *     OR EXISTS (job_status_transitions into 'cancelled')                         -- was ever cancelled
 *
 * (An editor's own decline does not close the window.)
 */
import { and, eq, sql } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { jobs, projects } from "@/db/schema";
import type { AuthContext, Job, JobPermissionRef } from "@/lib/types";
import { NotFoundError } from "@/server/errors";
import { jobRefFromRow } from "./permissions";

export interface LoadedJobRef {
  job: Job;
  ref: JobPermissionRef;
}

const pastEditorsSql = sql<string[]>`coalesce((select jsonb_agg(distinct ja.user_id order by ja.user_id) from job_assignments ja where ja.job_id = ${jobs.id} and ja.role = 'editor'), '[]'::jsonb)`;

const draftClosedSql = sql<boolean>`(
  ${jobs.startedAt} is not null
  or exists (select 1 from job_assignments ja where ja.job_id = ${jobs.id} and ja.role = 'editor'
             and ja.unassigned_at is not null and ja.unassigned_by_user_id is distinct from ja.user_id)
  or exists (select 1 from job_status_transitions t where t.job_id = ${jobs.id} and t.to_category = 'cancelled')
)`;

function toBool(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1;
}

function toIds(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Loads a job of the actor's organisation with its complete permission ref.
 * Missing / foreign ids → NotFoundError (callers then check `job.view` and map
 * an invisible job to 404 as well).
 */
export async function loadJobRef(db: DbLike, ctx: Pick<AuthContext, "organisationId">, jobId: string): Promise<LoadedJobRef> {
  const row = await first(
    db
      .select({ job: jobs, projectShared: projects.sharedWithClient, pastEditorIds: pastEditorsSql, draftClosed: draftClosedSql })
      .from(jobs)
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .where(and(eq(jobs.id, jobId), eq(jobs.organisationId, ctx.organisationId))),
  );
  if (!row) throw new NotFoundError("Job");
  return {
    job: row.job,
    ref: jobRefFromRow(row.job, {
      pastEditorIds: toIds(row.pastEditorIds),
      draftClosed: toBool(row.draftClosed),
      projectSharedWithClient: row.projectShared,
    }),
  };
}

/** Refs for many jobs of the actor's organisation (missing ids are absent). */
export async function loadJobRefs(db: DbLike, ctx: Pick<AuthContext, "organisationId">, jobIds: readonly string[]): Promise<Map<string, LoadedJobRef>> {
  const out = new Map<string, LoadedJobRef>();
  const unique = [...new Set(jobIds)];
  if (unique.length === 0) return out;
  const rows = await db
    .select({ job: jobs, projectShared: projects.sharedWithClient, pastEditorIds: pastEditorsSql, draftClosed: draftClosedSql })
    .from(jobs)
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .where(and(eq(jobs.organisationId, ctx.organisationId), sql`${jobs.id} in (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})`));
  for (const row of rows) {
    out.set(row.job.id, {
      job: row.job,
      ref: jobRefFromRow(row.job, {
        pastEditorIds: toIds(row.pastEditorIds),
        draftClosed: toBool(row.draftClosed),
        projectSharedWithClient: row.projectShared,
      }),
    });
  }
  return out;
}
