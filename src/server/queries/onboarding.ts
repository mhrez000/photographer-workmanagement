/**
 * First-run checklist for a new studio (front door). Admins only: anyone else gets `null`, so Home can call
 * it unconditionally. Every step is computed from the data, never stored:
 *
 *   createdFirstJob   ≥ 1 job
 *   invitedEditor     ≥ 1 editor account (active or pending)
 *   addedClient       ≥ 1 client
 *   assignedEditor    ≥ 1 job that has (or had) an editor
 *   approvedFirst     ≥ 1 job in approved / delivered / completed
 *
 * `isNewStudio` = fewer than 3 jobs AND the organisation is younger than 30 days; `dismissed` mirrors
 * `organisation_settings.onboarding_dismissed_at` (POST /api/settings/onboarding/dismiss).
 */
import { and, count, eq, inArray, isNotNull } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { clients, jobAssignments, jobs, organisationSettings, organisations, users } from "@/db/schema";
import type { AuthContext } from "@/lib/types";
import { isAdmin } from "@/server/auth/permissions";

export const NEW_STUDIO_MAX_JOBS = 3;
export const NEW_STUDIO_MAX_AGE_DAYS = 30;

export interface OnboardingSteps {
  createdFirstJob: boolean;
  invitedEditor: boolean;
  addedClient: boolean;
  assignedEditor: boolean;
  approvedFirst: boolean;
}

export interface OnboardingState {
  steps: OnboardingSteps;
  /** Steps done / 5. */
  completed: number;
  total: 5;
  dismissed: boolean;
  dismissedAt: string | null;
  /** Fewer than NEW_STUDIO_MAX_JOBS jobs and younger than NEW_STUDIO_MAX_AGE_DAYS days. */
  isNewStudio: boolean;
  jobCount: number;
  studioAgeDays: number;
  /** Show the checklist: admin, new studio, not dismissed, not every step done. */
  show: boolean;
}

async function countWhere(db: DbLike, q: Promise<{ n: number }[]> | PromiseLike<readonly { n: number }[]>): Promise<number> {
  return (await first(q))?.n ?? 0;
}

/** Admins: the checklist state; everyone else (team members, editors, clients, system): null. */
export async function getOnboarding(db: DbLike, ctx: AuthContext): Promise<OnboardingState | null> {
  if (!isAdmin(ctx) || ctx.isSystem || !ctx.userId) return null;
  const org = ctx.organisationId;
  const now = Date.parse(ctx.now());

  const organisation = await first(db.select({ createdAt: organisations.createdAt }).from(organisations).where(eq(organisations.id, org)));
  const settings = await first(db.select({ dismissedAt: organisationSettings.onboardingDismissedAt }).from(organisationSettings).where(eq(organisationSettings.organisationId, org)));
  const jobCount = await countWhere(db, db.select({ n: count() }).from(jobs).where(eq(jobs.organisationId, org)));
  const editors = await countWhere(db, db.select({ n: count() }).from(users).where(and(eq(users.organisationId, org), eq(users.role, "editor"))));
  const clientCount = await countWhere(db, db.select({ n: count() }).from(clients).where(eq(clients.organisationId, org)));
  const assigned = await countWhere(db, db.select({ n: count() }).from(jobAssignments).where(and(eq(jobAssignments.organisationId, org), eq(jobAssignments.role, "editor"))));
  const withEditorNow = await countWhere(db, db.select({ n: count() }).from(jobs).where(and(eq(jobs.organisationId, org), isNotNull(jobs.editorId))));
  const approved = await countWhere(
    db,
    db.select({ n: count() }).from(jobs).where(and(eq(jobs.organisationId, org), inArray(jobs.statusCategory, ["approved", "delivered", "completed"]))),
  );

  const steps: OnboardingSteps = {
    createdFirstJob: jobCount > 0,
    invitedEditor: editors > 0,
    addedClient: clientCount > 0,
    assignedEditor: assigned > 0 || withEditorNow > 0,
    approvedFirst: approved > 0,
  };
  const completed = Object.values(steps).filter(Boolean).length;
  const createdMs = organisation ? Date.parse(organisation.createdAt) : now;
  const studioAgeDays = Math.max(0, Math.floor((now - createdMs) / 86_400_000));
  const isNewStudio = jobCount < NEW_STUDIO_MAX_JOBS && studioAgeDays < NEW_STUDIO_MAX_AGE_DAYS;
  const dismissedAt = settings?.dismissedAt ?? null;
  return {
    steps,
    completed,
    total: 5,
    dismissed: dismissedAt !== null,
    dismissedAt,
    isNewStudio,
    jobCount,
    studioAgeDays,
    show: isNewStudio && dismissedAt === null && completed < 5,
  };
}
