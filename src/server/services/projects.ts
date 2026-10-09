/**
 * Projects service (ARCHITECTURE.md §2.2, §3.2, §5 project.*).
 *
 * - create: owner / manager / photographer, under a non-archived client
 * - edit: owner / manager any; photographer only projects they created.
 *   Moving a project to another client is allowed only while it has no
 *   jobs (jobs.client_id must equal projects.client_id; re-pointing a job's
 *   project — and re-syncing its client — is the jobs service's job).
 * - archive / restore: owner / manager; archive is blocked while the project
 *   has active jobs; restore requires a non-archived client.
 * - `resolveProjectForJob` is the loader the jobs service uses to validate a
 *   project for a new/edited job (in-org, not archived, client not archived).
 */
import { and, count, eq, inArray } from "drizzle-orm";
import { jobs, projects } from "@/db/schema";
import { CATEGORY_GROUPS } from "@/lib/constants";
import type { AuthContext, Client, Project } from "@/lib/types";
import { ArchiveProjectInput, CreateProjectInput, UpdateProjectInput } from "@/lib/validation/projects";
import { recordEvent } from "@/server/audit";
import { assertCan, type OrgResourceRef } from "@/server/auth/permissions";
import { loadClientInOrg, loadProjectInOrg, parseInput, type DbLike, type Tx } from "./_shared";
import { checkVersion, diffFields, ruleViolation, toStoredDate } from "./_admin";
import { assertRoleMayEver } from "./clients";

const EDITABLE = ["clientId", "name", "address", "description", "startDate", "endDate"] as const;

export function projectResourceRef(row: Project): OrgResourceRef {
  return { organisationId: row.organisationId, createdByUserId: row.createdByUserId ?? undefined };
}

function jobCountForProject(db: DbLike, ctx: AuthContext, projectId: string, activeOnly: boolean): number {
  const row = db
    .select({ n: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.organisationId, ctx.organisationId),
        eq(jobs.projectId, projectId),
        activeOnly ? inArray(jobs.statusCategory, [...CATEGORY_GROUPS.ACTIVE]) : undefined,
      ),
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Validates a project for use on a job: in the actor's org (else 404), not
 * archived, and its client not archived (else 400). Returns both rows so
 * the caller can copy `clientId` onto the job.
 */
export function resolveProjectForJob(db: DbLike, ctx: AuthContext, projectId: string): { project: Project; client: Client } {
  const project = loadProjectInOrg(db, ctx, projectId);
  const client = loadClientInOrg(db, ctx, project.clientId);
  if (project.archivedAt) throw ruleViolation("This project is archived", {}, "projectId");
  if (client.archivedAt) throw ruleViolation("This project's client is archived", {}, "projectId");
  return { project, client };
}

function eventValues(p: Pick<Project, "clientId" | "name" | "address" | "description" | "startDate" | "endDate">) {
  return { clientId: p.clientId, name: p.name, address: p.address, description: p.description, startDate: p.startDate, endDate: p.endDate };
}

export function createProject(tx: Tx, ctx: AuthContext, input: unknown): Project {
  assertCan(ctx, "project.create");
  const data = parseInput(CreateProjectInput, input);
  const client = loadClientInOrg(tx, ctx, data.clientId);
  if (client.archivedAt) throw ruleViolation("This client is archived", {}, "clientId");
  const tz = ctx.settings.timezone;
  const startDate = toStoredDate(data.startDate, tz) ?? null;
  const endDate = toStoredDate(data.endDate, tz) ?? null;
  if (startDate && endDate && endDate < startDate) throw ruleViolation("End date must be on or after the start date", {}, "endDate");
  const now = ctx.now();
  const row = tx
    .insert(projects)
    .values({
      organisationId: ctx.organisationId,
      clientId: client.id,
      name: data.name,
      address: data.address ?? null,
      description: data.description ?? null,
      startDate,
      endDate,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "project",
    entityId: row.id,
    eventType: "project.created",
    action: "created",
    previousValue: null,
    newValue: eventValues(row),
    metadata: { projectId: row.id, clientName: client.name },
  });
  return row;
}

export function updateProject(tx: Tx, ctx: AuthContext, input: unknown): Project {
  assertRoleMayEver(ctx, "project.edit");
  const data = parseInput(UpdateProjectInput, input);
  const project = loadProjectInOrg(tx, ctx, data.projectId);
  assertCan(ctx, "project.edit", projectResourceRef(project));
  checkVersion(project, data.expectedVersion, project);

  const tz = ctx.settings.timezone;
  const patch = {
    ...data,
    startDate: toStoredDate(data.startDate, tz),
    endDate: toStoredDate(data.endDate, tz),
  };
  const diff = diffFields(project, patch, EDITABLE);
  if (diff.changed.length === 0) return project;

  const meta: Record<string, unknown> = { projectId: project.id };
  if (diff.changed.includes("clientId")) {
    const nextClient = loadClientInOrg(tx, ctx, diff.set.clientId as string);
    if (nextClient.archivedAt) throw ruleViolation("That client is archived", {}, "clientId");
    const jobCount = jobCountForProject(tx, ctx, project.id, false);
    if (jobCount > 0) {
      throw ruleViolation(
        `This project has ${jobCount} job${jobCount === 1 ? "" : "s"}; it cannot be moved to another client. Create a new project instead.`,
        { jobCount },
        "clientId",
      );
    }
    meta.fromLabel = loadClientInOrg(tx, ctx, project.clientId).name;
    meta.toLabel = nextClient.name;
  }
  const startDate = diff.changed.includes("startDate") ? (diff.set.startDate ?? null) : project.startDate;
  const endDate = diff.changed.includes("endDate") ? (diff.set.endDate ?? null) : project.endDate;
  if (startDate && endDate && endDate < startDate) throw ruleViolation("End date must be on or after the start date", {}, "endDate");

  const row = tx
    .update(projects)
    .set({ ...diff.set, updatedAt: ctx.now(), version: project.version + 1 })
    .where(eq(projects.id, project.id))
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "project",
    entityId: project.id,
    eventType: "project.updated",
    action: "updated",
    previousValue: diff.previous,
    newValue: diff.next,
    metadata: { ...meta, name: row.name },
  });
  return row;
}

export function archiveProject(tx: Tx, ctx: AuthContext, input: unknown): Project {
  assertCan(ctx, "project.archive");
  const data = parseInput(ArchiveProjectInput, input);
  const project = loadProjectInOrg(tx, ctx, data.projectId);
  assertCan(ctx, "project.archive", projectResourceRef(project));
  checkVersion(project, data.expectedVersion, project);
  if (project.archivedAt) throw ruleViolation("This project is already archived");
  const active = jobCountForProject(tx, ctx, project.id, true);
  if (active > 0) {
    throw ruleViolation(`This project has ${active} active job${active === 1 ? "" : "s"}. Complete or cancel them before archiving.`, {
      activeJobCount: active,
    });
  }
  const now = ctx.now();
  const row = tx
    .update(projects)
    .set({ archivedAt: now, updatedAt: now, version: project.version + 1 })
    .where(eq(projects.id, project.id))
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "project",
    entityId: project.id,
    eventType: "project.archived",
    action: "archived",
    previousValue: { archivedAt: null },
    newValue: { archivedAt: now },
    metadata: { projectId: project.id, name: project.name },
  });
  return row;
}

export function restoreProject(tx: Tx, ctx: AuthContext, input: unknown): Project {
  assertCan(ctx, "project.archive");
  const data = parseInput(ArchiveProjectInput, input);
  const project = loadProjectInOrg(tx, ctx, data.projectId);
  assertCan(ctx, "project.archive", projectResourceRef(project));
  checkVersion(project, data.expectedVersion, project);
  if (!project.archivedAt) throw ruleViolation("This project is not archived");
  const client = loadClientInOrg(tx, ctx, project.clientId);
  if (client.archivedAt) throw ruleViolation("Restore the client first: it is archived");
  const row = tx
    .update(projects)
    .set({ archivedAt: null, updatedAt: ctx.now(), version: project.version + 1 })
    .where(eq(projects.id, project.id))
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "project",
    entityId: project.id,
    eventType: "project.restored",
    action: "restored",
    previousValue: { archivedAt: project.archivedAt },
    newValue: { archivedAt: null },
    metadata: { projectId: project.id, name: project.name },
  });
  return row;
}
