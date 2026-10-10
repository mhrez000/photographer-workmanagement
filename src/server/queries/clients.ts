/**
 * Clients list + detail (ARCHITECTURE.md §10 `/clients`, `/clients/[id]`).
 *
 * client.view: O/M/P every client of the org; editors only clients with at
 * least one job visible to them (others look missing → 404). Counts and job
 * rows are org-wide for management and visibility-scoped for P/E.
 */
import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { first, type DbLike } from "@/db/index";
import { clients, jobs, projects } from "@/db/schema";
import type { AuthContext, ClientDetail, ClientListItem } from "@/lib/types";
import { assertCan, can, isManagement, visibleJobsWhere } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { loadClientInOrg, parseInput } from "@/server/services/_shared";
import { binaryAsc, EMPTY_COUNTS, jobCountsBy, loadUserRefs } from "./metrics";
import { DETAIL_JOB_LIMIT, hasVisibleJobSql, listProjects } from "./projects";
import { likeSql, selectJobRows } from "./scope";

const flag = z.preprocess((v) => (Array.isArray(v) ? v[0] : v), z.union([z.boolean(), z.enum(["1", "0", "true", "false"])]).optional()).transform(
  (v) => v === true || v === "1" || v === "true",
);
const one = z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), z.string().trim().min(1).max(200).optional());

export const ClientListFiltersSchema = z.object({
  q: one,
  includeArchived: flag,
});

const CLIENT_FIELDS = {
  id: clients.id,
  name: clients.name,
  contactName: clients.contactName,
  email: clients.email,
  phone: clients.phone,
  colour: clients.colour,
  archivedAt: clients.archivedAt,
  createdByUserId: clients.createdByUserId,
  createdAt: clients.createdAt,
  version: clients.version,
};

/** Non-archived project count per client (editors: projects with a visible job). */
async function projectCounts(db: DbLike, ctx: AuthContext): Promise<Map<string, number>> {
  const rows = await db
    .select({ clientId: projects.clientId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(projects)
    .where(
      and(
        eq(projects.organisationId, ctx.organisationId),
        isNull(projects.archivedAt),
        ctx.role === "editor" ? hasVisibleJobSql(ctx, "projectId", projects.id) : undefined,
      ),
    )
    .groupBy(projects.clientId);
  return new Map(rows.map((r) => [r.clientId, r.n]));
}

/** `GET /api/clients?q&includeArchived` (client.view). */
export async function listClients(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<ClientListItem[]> {
  assertCan(ctx, "client.view");
  const f = parseInput(ClientListFiltersSchema, input ?? {});
  const parts: (SQL | undefined)[] = [eq(clients.organisationId, ctx.organisationId)];
  if (!f.includeArchived) parts.push(isNull(clients.archivedAt));
  if (f.q) parts.push(or(likeSql(clients.name, f.q), likeSql(clients.contactName, f.q), likeSql(clients.email, f.q)));
  if (ctx.role === "editor") parts.push(hasVisibleJobSql(ctx, "clientId", clients.id));
  const rows = await db
    .select(CLIENT_FIELDS)
    .from(clients)
    .where(and(...parts))
    .orderBy(binaryAsc(clients.name), asc(clients.id));
  const counts = await jobCountsBy(db, ctx, "clientId", { scope: isManagement(ctx) ? "org" : "visible" });
  const projectsPer = await projectCounts(db, ctx);
  return rows.map((client) => ({ client, projectCount: projectsPer.get(client.id) ?? 0, counts: { ...(counts.get(client.id) ?? EMPTY_COUNTS) } }));
}

/** `GET /api/clients/:id` → ClientDetail (projects + visible jobs). Foreign / not visible → 404. */
export async function getClientDetail(db: DbLike, ctx: AuthContext, clientId: string): Promise<ClientDetail> {
  const client = await loadClientInOrg(db, ctx, clientId);
  const hasVisibleJob =
    ctx.role === "editor"
      ? (await first(db.select({ one: sql<number>`1` }).from(jobs).where(and(eq(jobs.clientId, client.id), visibleJobsWhere(ctx))).limit(1))) !== undefined
      : undefined;
  if (!can(ctx, "client.view", { organisationId: client.organisationId, createdByUserId: client.createdByUserId ?? undefined, hasVisibleJob })) {
    if (ctx.role === "editor") throw new NotFoundError("Client");
    assertCan(ctx, "client.view");
  }
  const counts = await jobCountsBy(db, ctx, "clientId", { scope: isManagement(ctx) ? "org" : "visible", where: eq(jobs.clientId, client.id) });
  const projectList = await listProjects(db, ctx, { clientId: client.id, includeArchived: true });
  const createdBy = client.createdByUserId ? ((await loadUserRefs(db, ctx, [client.createdByUserId])).get(client.createdByUserId) ?? null) : null;
  const jobRows = await selectJobRows(db, ctx, { where: eq(jobs.clientId, client.id), limit: DETAIL_JOB_LIMIT });
  return {
    client: {
      id: client.id,
      name: client.name,
      contactName: client.contactName,
      email: client.email,
      phone: client.phone,
      colour: client.colour,
      archivedAt: client.archivedAt,
      createdByUserId: client.createdByUserId,
      createdAt: client.createdAt,
      version: client.version,
    },
    projectCount: projectList.filter((p) => p.project.archivedAt === null).length,
    counts: { ...(counts.get(client.id) ?? EMPTY_COUNTS) },
    notes: isManagement(ctx) || ctx.role === "photographer" ? client.notes : null,
    createdBy,
    projects: projectList,
    jobs: jobRows,
  };
}
