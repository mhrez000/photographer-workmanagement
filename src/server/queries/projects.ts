/**
 * Projects list + detail (ARCHITECTURE.md §10 `/projects`, `/projects/[id]`).
 *
 * project.view: O/M/P any project of the org; editors only projects that
 * have at least one job visible to them (others look missing → 404).
 * Job counts and job rows always go through `visibleJobsWhere(ctx)` for
 * photographers/editors, and are org-wide for management.
 */
import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { first, type DbLike } from "@/db/index";
import { clients, jobs, projects } from "@/db/schema";
import type { AuthContext, ProjectDetail, ProjectListItem } from "@/lib/types";
import { assertCan, can, isManagement, visibleJobsWhere } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { loadProjectInOrg, parseInput, userRef } from "@/server/services/_shared";
import { binaryAsc, EMPTY_COUNTS, jobCountsBy, loadUserRefs } from "./metrics";
import { likeSql, selectJobRows } from "./scope";

export const DETAIL_JOB_LIMIT = 200;

const flag = z.preprocess((v) => (Array.isArray(v) ? v[0] : v), z.union([z.boolean(), z.enum(["1", "0", "true", "false"])]).optional()).transform(
  (v) => v === true || v === "1" || v === "true",
);
const one = z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), z.string().trim().min(1).max(200).optional());

export const ProjectListFiltersSchema = z.object({
  clientId: one,
  q: one,
  includeArchived: flag,
});

/** Visible-job existence predicate for a project/client column (editors' scope). */
export function hasVisibleJobSql(ctx: AuthContext, column: "projectId" | "clientId", idColumn: SQL | typeof projects.id | typeof clients.id): SQL {
  const target = column === "projectId" ? jobs.projectId : jobs.clientId;
  return sql`exists (select 1 from ${jobs} where ${target} = ${idColumn} and ${visibleJobsWhere(ctx)})`;
}

const PROJECT_FIELDS = {
  id: projects.id,
  name: projects.name,
  clientId: projects.clientId,
  address: projects.address,
  startDate: projects.startDate,
  endDate: projects.endDate,
  archivedAt: projects.archivedAt,
  createdByUserId: projects.createdByUserId,
  createdAt: projects.createdAt,
  version: projects.version,
  clientName: clients.name,
};

/** `GET /api/projects?clientId&q&includeArchived` (project.view). */
export async function listProjects(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<ProjectListItem[]> {
  assertCan(ctx, "project.view");
  const f = parseInput(ProjectListFiltersSchema, input ?? {});
  const parts: (SQL | undefined)[] = [eq(projects.organisationId, ctx.organisationId)];
  if (!f.includeArchived) parts.push(isNull(projects.archivedAt));
  if (f.clientId) parts.push(eq(projects.clientId, f.clientId));
  if (f.q) parts.push(or(likeSql(projects.name, f.q), likeSql(projects.address, f.q), likeSql(clients.name, f.q)));
  if (ctx.role === "editor") parts.push(hasVisibleJobSql(ctx, "projectId", projects.id));
  const rows = await db
    .select(PROJECT_FIELDS)
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .where(and(...parts))
    .orderBy(binaryAsc(projects.name), asc(projects.id));
  const counts = await jobCountsBy(db, ctx, "projectId", { scope: isManagement(ctx) ? "org" : "visible" });
  return rows.map((r) => toItem(r, counts.get(r.id)));
}

type ProjectSelectRow = ProjectListItem["project"] & { clientName: string };

function toItem(row: ProjectSelectRow, counts = EMPTY_COUNTS): ProjectListItem {
  const { clientName, ...project } = row;
  return { project, client: { id: row.clientId, name: clientName }, counts: { ...counts } };
}

/** `GET /api/projects/:id` → ProjectDetail with the visible jobs table. Foreign / not visible → 404. */
export async function getProjectDetail(db: DbLike, ctx: AuthContext, projectId: string): Promise<ProjectDetail> {
  const project = await loadProjectInOrg(db, ctx, projectId);
  const hasVisibleJob =
    ctx.role === "editor"
      ? (await first(db.select({ one: sql<number>`1` }).from(jobs).where(and(eq(jobs.projectId, project.id), visibleJobsWhere(ctx))).limit(1))) !== undefined
      : undefined;
  if (!can(ctx, "project.view", { organisationId: project.organisationId, createdByUserId: project.createdByUserId ?? undefined, hasVisibleJob })) {
    if (ctx.role === "editor") throw new NotFoundError("Project");
    assertCan(ctx, "project.view");
  }
  const client = await first(db.select({ id: clients.id, name: clients.name }).from(clients).where(eq(clients.id, project.clientId)));
  const counts = await jobCountsBy(db, ctx, "projectId", { scope: isManagement(ctx) ? "org" : "visible", where: eq(jobs.projectId, project.id) });
  const createdBy = project.createdByUserId ? ((await loadUserRefs(db, ctx, [project.createdByUserId])).get(project.createdByUserId) ?? null) : null;
  const jobRows = await selectJobRows(db, ctx, { where: eq(jobs.projectId, project.id), limit: DETAIL_JOB_LIMIT });
  return {
    project: {
      id: project.id,
      name: project.name,
      clientId: project.clientId,
      address: project.address,
      startDate: project.startDate,
      endDate: project.endDate,
      archivedAt: project.archivedAt,
      createdByUserId: project.createdByUserId,
      createdAt: project.createdAt,
      version: project.version,
    },
    client: { id: project.clientId, name: client?.name ?? "" },
    counts: { ...(counts.get(project.id) ?? EMPTY_COUNTS) },
    description: project.description,
    createdBy: createdBy ? userRef(createdBy) : null,
    jobs: jobRows,
  };
}
