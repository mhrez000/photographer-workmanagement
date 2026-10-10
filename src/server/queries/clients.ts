/**
 * Clients list + detail (ARCHITECTURE.md §10 `/clients`, `/clients/[id]`;
 * docs/ROLES.md §2.4, §3.4).
 *
 * client.view: admins and team members every client of the org; editors only
 * clients with at least one job visible to them (others look missing → 404)
 * and only the name + colour (contact name, email, phone and notes are
 * private; their `q` matches the name only). Clients (portal users) never
 * reach these reads (client.view → 403). Counts and job rows go through
 * `visibleJobsWhere` (`resolveMetricScope(ctx, null)`: admins and ⚑all
 * members see every job anyway).
 */
import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { first, type DbLike } from "@/db/index";
import { clients, jobs, projects } from "@/db/schema";
import type { AuthContext, ClientDetail, ClientListItem } from "@/lib/types";
import { assertCan, can, visibleJobsWhere } from "@/server/auth/permissions";
import { resolveMetricScope } from "@/server/view-scope";
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
  portalEnabled: clients.portalEnabled,
  feedbackEnabled: clients.feedbackEnabled,
};

/** Editors see a client's name and colour only (§2.4). */
function redactClient<T extends { contactName: string | null; email: string | null; phone: string | null }>(ctx: AuthContext, client: T): T {
  if (ctx.role !== "editor" || ctx.isSystem) return client;
  return { ...client, contactName: null, email: null, phone: null };
}

/** Job-count metric scope for client/project lists: never the scope switch (§8 "does not apply"). */
function countScope(ctx: AuthContext): "org" | "visible" {
  return resolveMetricScope(ctx, null).metric;
}

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
  if (f.q) {
    // Editors: name only (contact name / email are private, §2.4).
    parts.push(ctx.role === "editor" ? likeSql(clients.name, f.q) : or(likeSql(clients.name, f.q), likeSql(clients.contactName, f.q), likeSql(clients.email, f.q)));
  }
  if (ctx.role === "editor") parts.push(hasVisibleJobSql(ctx, "clientId", clients.id));
  const rows = await db
    .select(CLIENT_FIELDS)
    .from(clients)
    .where(and(...parts))
    .orderBy(binaryAsc(clients.name), asc(clients.id));
  const counts = await jobCountsBy(db, ctx, "clientId", { scope: countScope(ctx) });
  const projectsPer = await projectCounts(db, ctx);
  return rows.map((client) => ({
    client: redactClient(ctx, client),
    projectCount: projectsPer.get(client.id) ?? 0,
    counts: { ...(counts.get(client.id) ?? EMPTY_COUNTS) },
  }));
}

/** `GET /api/clients/:id` → ClientDetail (projects + visible jobs). Foreign / not visible → 404. */
export async function getClientDetail(db: DbLike, ctx: AuthContext, clientId: string): Promise<ClientDetail> {
  assertCan(ctx, "client.view");
  const client = await loadClientInOrg(db, ctx, clientId);
  const hasVisibleJob =
    ctx.role === "editor"
      ? (await first(db.select({ one: sql<number>`1` }).from(jobs).where(and(eq(jobs.clientId, client.id), visibleJobsWhere(ctx))).limit(1))) !== undefined
      : undefined;
  if (!can(ctx, "client.view", { organisationId: client.organisationId, createdByUserId: client.createdByUserId ?? undefined, hasVisibleJob })) {
    if (ctx.role === "editor") throw new NotFoundError("Client");
    assertCan(ctx, "client.view");
  }
  const counts = await jobCountsBy(db, ctx, "clientId", { scope: countScope(ctx), where: eq(jobs.clientId, client.id) });
  const projectList = await listProjects(db, ctx, { clientId: client.id, includeArchived: true });
  const createdBy = client.createdByUserId ? ((await loadUserRefs(db, ctx, [client.createdByUserId])).get(client.createdByUserId) ?? null) : null;
  const jobRows = await selectJobRows(db, ctx, { where: eq(jobs.clientId, client.id), limit: DETAIL_JOB_LIMIT });
  return {
    client: redactClient(ctx, {
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
      portalEnabled: client.portalEnabled,
      feedbackEnabled: client.feedbackEnabled,
    }),
    projectCount: projectList.filter((p) => p.project.archivedAt === null).length,
    counts: { ...(counts.get(client.id) ?? EMPTY_COUNTS) },
    // Client notes: admins and team members; never editors (§2.1, §2.4).
    notes: ctx.role === "photographer" || ctx.isSystem ? client.notes : null,
    createdBy,
    projects: projectList,
    jobs: jobRows,
  };
}
