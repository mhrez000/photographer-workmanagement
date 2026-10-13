/**
 * Lightweight picker lists for client islands (assign dialogs, @mention
 * autocomplete, the create-job client → project cascade; docs/ROLES.md §3.4).
 * Read-only. The job-creation options are SEPARATE queries, never built on
 * the list queries, and project only the fields a picker needs:
 *
 *   GET /api/users/options?role=editor&jobId=&includeInactive=1&excludeSelf=1
 *     - reduced projection (`id, name, title, role, isAdmin, isPrimaryOwner,
 *       avatarColour, isActive`); client portal users never appear for
 *       non-admins (`role=client` → 400 for them);
 *     - the studio roster is never revealed to people who do not work with it
 *       (SIMPLIFICATION-PLAN §2, reviewer finding E17 — `rosterScopeSql`):
 *         admins                      everyone;
 *         non-admin photographers     every editor (they assign), themselves, the
 *                                     owner / co-owners and the photographers on jobs
 *                                     they can see (everyone with ⚑See all jobs);
 *         editors                     themselves, the owner / co-owners and the
 *                                     photographers on their jobs (for @mentions);
 *     - `role=photographer` (active photographers) is open to anyone who can
 *       `job.create` (an editor with "Can add their own jobs" has to pick the
 *       photographer of the job they create — the one exception to the scope);
 *     - `jobId` reveals who can view a job, so it requires `comment.mention`
 *       on that job (404 when the job is not visible, else 403); the roster
 *       scope still applies on top.
 *   GET /api/clients/options?q=           → `{ id, name, colour }` of non-archived clients
 *     - admins every client; an extra photographer the clients on their jobs or
 *       created by them (plan §2; `clientScopeSql` — the New job form lets them
 *       type a new name instead); editors who can `job.create` every client (they
 *       create jobs for clients they have never worked for), other editors the
 *       clients of visible jobs.
 *   GET /api/projects/options?clientId=&q= → `{ id, name, clientId, clientName }` of non-archived projects
 *     - to anyone who can `job.create`; otherwise the `project.view` scope
 *       (editors: projects of visible jobs).
 * Clients (portal users) get 403 everywhere.
 */
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { clients, jobs, projects, users } from "@/db/schema";
import { ROLES, STAFF_ROLES } from "@/lib/constants";
import type { AuthContext, ClientOption, ProjectOption, UserOption } from "@/lib/types";
import { assertCan, can, isAdmin, visibleJobsWhere } from "@/server/auth/permissions";
import { ForbiddenError } from "@/server/errors";
import { userCanViewJob } from "@/server/services/_collab";
import { parseInput } from "@/server/services/_shared";
import { binaryAsc } from "./metrics";
import { clientScopeSql } from "./clients";
import { hasVisibleJobSql } from "./projects";
import { assertStaffRead, likeSql, loadVisibleJob } from "./scope";
import { primaryOwnerIdOf, reducedUser } from "./users";
import { canViewTeamWorkloads, computeWorkloads } from "./workloads";

const toList = (v: unknown) =>
  v === undefined || v === ""
    ? undefined
    : (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean);
const one = (v: unknown) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v);
const bool = z.preprocess((v) => {
  const s = one(v);
  return s === undefined ? undefined : ["1", "true", "yes"].includes(String(s).toLowerCase());
}, z.boolean().optional());

const userOptionFields = {
  /** Only people who may view this job (mention autocomplete; needs comment.mention on it). */
  jobId: z.preprocess(one, z.string().trim().min(1).max(64).optional()),
  /** Include deactivated people (default: active only). */
  includeInactive: bool,
  /** Leave the actor out (mentions). */
  excludeSelf: bool,
  q: z.preprocess(one, z.string().trim().min(1).max(200).optional()),
};

/** Admin query: any role (`role=editor`, `role=photographer,editor`, `role=a&role=b`). */
export const UserOptionsQuerySchema = z.object({ role: z.preprocess(toList, z.array(z.enum(ROLES)).optional()), ...userOptionFields });

/** Team members / editors: staff roles only (`role=client` → 400, §3.4). */
export const StaffUserOptionsQuerySchema = z.object({ role: z.preprocess(toList, z.array(z.enum(STAFF_ROLES)).optional()), ...userOptionFields });

/**
 * The people a non-admin staff member may see in a picker (file header; null = no restriction): themselves,
 * the owner / co-owners, the photographers (shooter or creator) of the jobs visible to them, and — for
 * photographers, who assign — every editor. Rows are later filtered to STAFF roles anyway.
 */
export function rosterScopeSql(ctx: AuthContext): SQL | null {
  if (isAdmin(ctx) || ctx.userId === null) return null;
  // ⚑See all jobs: every job is theirs to read, so the roster is nothing new to them.
  if (ctx.role === "photographer" && ctx.canViewAllJobs) return null;
  const onMyJobs = sql`${users.role} = 'photographer' and (${users.id} in (select ${jobs.photographerId} from ${jobs} where ${visibleJobsWhere(ctx)}) or ${users.id} in (select ${jobs.createdByUserId} from ${jobs} where ${visibleJobsWhere(ctx)}))`;
  const parts: SQL[] = [eq(users.id, ctx.userId), sql`(${users.role} = 'photographer' and ${users.isAdmin} = true)`, onMyJobs];
  if (ctx.role === "photographer") parts.push(eq(users.role, "editor"));
  return or(...parts) as SQL;
}

/** People picker (reduced projection; editors carry workload when the actor may see team workloads). */
export async function getUserOptions(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<UserOption[]> {
  assertStaffRead(ctx);
  const admin = isAdmin(ctx);
  const f = admin ? parseInput(UserOptionsQuerySchema, input ?? {}) : parseInput(StaffUserOptionsQuerySchema, input ?? {});
  const roles = f.role && f.role.length > 0 ? [...new Set(f.role)] : null;
  const photographersOnly = roles !== null && roles.length === 1 && roles[0] === "photographer";
  // The job-create photographer picker is open to creators; every other list needs user.view.
  const createPicker = photographersOnly && can(ctx, "job.create");
  if (!createPicker) assertCan(ctx, "user.view");

  let jobRef = null;
  if (f.jobId) {
    // 404 when the actor cannot see the job (existence never leaks); 403 without comment.mention.
    jobRef = (await loadVisibleJob(db, ctx, f.jobId)).ref;
    if (!can(ctx, "comment.mention", jobRef)) throw new ForbiddenError("comment.mention");
  }

  const parts: (SQL | undefined)[] = [eq(users.organisationId, ctx.organisationId), isNull(users.anonymisedAt)];
  parts.push(inArray(users.role, roles ?? (admin ? [...ROLES] : [...STAFF_ROLES])));
  if (!admin) parts.push(inArray(users.role, [...STAFF_ROLES]));
  // Roster scope (E17): the job-create photographer picker is the one list that may name every photographer.
  if (!(createPicker && ctx.role === "editor")) parts.push(rosterScopeSql(ctx) ?? undefined);
  if (!f.includeInactive || photographersOnly) parts.push(eq(users.isActive, true));
  if (f.q) parts.push(admin ? or(likeSql(users.name, f.q), likeSql(users.email, f.q)) : likeSql(users.name, f.q));
  const rows = (
    await db
      .select()
      .from(users)
      .where(and(...parts))
      .orderBy(binaryAsc(users.name), asc(users.id))
  ).filter((u) => !(f.excludeSelf && u.id === ctx.userId));

  const primary = await primaryOwnerIdOf(db, ctx);
  let people = rows.map((u) => reducedUser(u, primary));
  if (jobRef) {
    const viewers = [];
    for (const u of people) {
      if (u.isActive && (await userCanViewJob(db, ctx, u.id, jobRef))) viewers.push(u);
    }
    people = viewers;
  }

  const editorIds = people.filter((u) => u.role === "editor").map((u) => u.id);
  const workloads = new Map<string, UserOption["workload"]>();
  if (editorIds.length > 0 && canViewTeamWorkloads(ctx)) {
    for (const row of (await computeWorkloads(db, ctx, { editorIds })).rows) {
      workloads.set(row.editor.id, { band: row.band, active: row.active, overdue: row.overdue });
    }
  }
  return people.map((u) => ({ ...u, workload: workloads.get(u.id) ?? null }));
}

/** Client picker: `{ id, name, colour }` of non-archived clients (see file header for the scope). */
export async function getClientOptions(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<ClientOption[]> {
  assertStaffRead(ctx);
  const q = z.preprocess(one, z.string().trim().max(200).optional()).parse(input && typeof input === "object" ? (input as Record<string, unknown>).q : undefined);
  const creator = can(ctx, "job.create");
  if (!creator) assertCan(ctx, "client.view");
  const rows = await db
    .select({ id: clients.id, name: clients.name, colour: clients.colour })
    .from(clients)
    .where(
      and(
        eq(clients.organisationId, ctx.organisationId),
        isNull(clients.archivedAt),
        q ? likeSql(clients.name, q) : undefined,
        // Editors who create jobs pick any client; everyone else sees their own clients (file header).
        creator && ctx.role === "editor" ? undefined : (clientScopeSql(ctx) ?? undefined),
      ),
    )
    .orderBy(binaryAsc(clients.name), asc(clients.id));
  return rows.map((c) => ({ id: c.id, name: c.name, colour: c.colour }));
}

/** Project picker: `{ id, name, clientId, clientName }` of non-archived projects (optionally of one client). */
export async function getProjectOptions(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<ProjectOption[]> {
  assertStaffRead(ctx);
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const text = z.preprocess(one, z.string().trim().max(200).optional());
  const clientId = text.parse(o.clientId);
  const q = text.parse(o.q);
  const creator = can(ctx, "job.create");
  if (!creator) assertCan(ctx, "project.view");
  const rows = await db
    .select({ id: projects.id, name: projects.name, clientId: projects.clientId, clientName: clients.name })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .where(
      and(
        eq(projects.organisationId, ctx.organisationId),
        isNull(projects.archivedAt),
        isNull(clients.archivedAt),
        clientId ? eq(projects.clientId, clientId) : undefined,
        q ? or(likeSql(projects.name, q), likeSql(projects.address, q)) : undefined,
        !creator && ctx.role === "editor" ? hasVisibleJobSql(ctx, "projectId", projects.id) : undefined,
      ),
    )
    .orderBy(binaryAsc(projects.name), asc(projects.id));
  return rows.map((p) => ({ id: p.id, name: p.name, clientId: p.clientId, clientName: p.clientName }));
}
