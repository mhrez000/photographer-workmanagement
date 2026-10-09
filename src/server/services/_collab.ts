/**
 * Helpers shared by the collaboration services (comments, notes, links,
 * time tracking). Internal to src/server/services — not a public API.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { users } from "@/db/schema";
import type { AuthContext, Job, JobPermissionRef, UserRef } from "@/lib/types";
import { can } from "@/server/auth/permissions";
import { buildContextFromDb } from "@/server/auth/session";
import { NotFoundError } from "@/server/errors";
import { jobPermissionRef, loadJobInOrg, loadPastEditorIds, userRef } from "./_shared";

/** A job row plus its full permission ref (pastEditorIds always loaded). */
export interface LoadedJob {
  job: Job;
  ref: JobPermissionRef;
}

/**
 * Loads a job the actor can SEE (`job.view`) in the actor's org with
 * `pastEditorIds` populated, so the ref can be evaluated for any role (actor
 * or a mention target / notification recipient).
 *
 * A job that is missing, in another org, or merely invisible to the actor all
 * throw the same 404 — a 403 here would reveal that the id exists. Callers
 * keep their own action checks (`comment.add`, `link.replace`, …), which
 * still answer 403 for a VISIBLE job where that specific action is denied.
 */
export function loadJobWithRef(db: DbLike, ctx: AuthContext, jobId: string): LoadedJob {
  const job = loadJobInOrg(db, ctx, jobId);
  const ref = jobPermissionRef(job, loadPastEditorIds(db, job.id));
  if (!can(ctx, "job.view", ref)) throw new NotFoundError("Job");
  return { job, ref };
}

/** `{ jobNumber, jobName }` for event metadata (feeds render job labels from it). */
export function jobMeta(job: Pick<Job, "jobNumber" | "name">): { jobNumber: string; jobName: string } {
  return { jobNumber: job.jobNumber, jobName: job.name };
}

/** id → UserRef for the given ids within the actor's organisation (unknown ids are skipped). */
export function loadUserRefMap(db: DbLike, ctx: AuthContext, ids: readonly (string | null | undefined)[]): Map<string, UserRef> {
  const unique = Array.from(new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0)));
  const map = new Map<string, UserRef>();
  if (unique.length === 0) return map;
  const rows = db
    .select({ id: users.id, name: users.name, role: users.role, avatarColour: users.avatarColour, isActive: users.isActive })
    .from(users)
    .where(and(inArray(users.id, unique), eq(users.organisationId, ctx.organisationId)))
    .all();
  for (const row of rows) map.set(row.id, userRef(row));
  return map;
}

/** Placeholder for a user id that no longer resolves (should not happen: users are never deleted). */
export function unknownUserRef(id: string): UserRef {
  return { id, name: "Unknown user", role: "editor", avatarColour: "#64748b", isActive: false };
}

/**
 * Whether `userId` (another person in the actor's org) may view the job —
 * evaluated with that user's own fresh context (role, team, org flags).
 * Inactive, anonymised or foreign users → false.
 */
export function userCanViewJob(db: DbLike, ctx: AuthContext, userId: string, ref: JobPermissionRef): boolean {
  const target = buildContextFromDb(db, userId, { now: ctx.now, requestId: ctx.requestId });
  if (!target || target.organisationId !== ctx.organisationId) return false;
  return can(target, "job.view", ref);
}
