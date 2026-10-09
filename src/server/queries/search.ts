/**
 * Global search (ARCHITECTURE.md §10 `/search`, ⌘K palette).
 *
 * Jobs are matched on number, name, description, note bodies and comment
 * bodies — always through `visibleJobsWhere(ctx)`. An exact job number
 * (`PJ-0142`, case-insensitive, or just `142`) ranks first and is returned as
 * `exactJob` for deep-linking. Notes: photographers / editors never match on
 * internal notes; archived notes and soft-deleted comments never match.
 * Clients / projects: owners, managers and photographers search the whole
 * organisation; editors only those of jobs visible to them. People: active
 * users of the organisation (name; email too for owners / managers).
 */
import { and, asc, desc, eq, exists, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { clients, jobComments, jobNotes, jobs, projects, users } from "@/db/schema";
import { JOB_NUMBER_PAD } from "@/lib/constants";
import type { AuthContext, SearchResults } from "@/lib/types";
import { assertCan, can, isManagement } from "@/server/auth/permissions";
import { likeSql, selectRawJobs, visibleJobsWhere, type RawJobRow } from "./scope";

export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 50;

type JobHit = SearchResults["jobs"][number];
type MatchedIn = JobHit["matchedIn"];

export function emptySearchResults(query: string): SearchResults {
  return { query, jobs: [], clients: [], projects: [], users: [], exactJob: null };
}

/** SQL matching `term` as a whole job number (case-insensitive; bare digits match the padded suffix). */
function exactNumberSql(term: string): SQL {
  const parts: SQL[] = [sql`upper(${jobs.jobNumber}) = upper(${term})`];
  if (/^\d+$/.test(term)) {
    const padded = term.length >= JOB_NUMBER_PAD ? term : term.padStart(JOB_NUMBER_PAD, "0");
    parts.push(sql`${jobs.jobNumber} like ${`%-${padded}`}`);
  }
  return or(...parts) as SQL;
}

function toHit(raw: RawJobRow, matchedIn: MatchedIn): JobHit {
  return {
    id: raw.job.id,
    jobNumber: raw.job.jobNumber,
    name: raw.job.name,
    status: { ...raw.status },
    client: { id: raw.client.id, name: raw.client.name },
    matchedIn,
  };
}

export function globalSearch(db: DbLike, ctx: AuthContext, query: string, opts: { limit?: number } = {}): SearchResults {
  assertCan(ctx, "search.global");
  const term = (query ?? "").trim().slice(0, 200);
  if (term.length === 0) return emptySearchResults(term);
  const limit = Math.min(Math.max(opts.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
  const org = ctx.organisationId;

  /* ---------------- jobs ---------------- */
  const exact = exactNumberSql(term);
  const exactRaw = selectRawJobs(db, ctx, { where: exact, orderBy: [sql`length(${jobs.jobNumber})`, asc(jobs.jobNumber)], limit: 1 })[0];

  const hits = new Map<string, JobHit>();
  const add = (raws: readonly RawJobRow[], matchedIn: (r: RawJobRow) => MatchedIn) => {
    for (const r of raws) {
      if (hits.size >= limit) return;
      if (!hits.has(r.job.id)) hits.set(r.job.id, toHit(r, matchedIn(r)));
    }
  };
  if (exactRaw) add([exactRaw], () => "number");

  const direct = selectRawJobs(db, ctx, {
    where: or(exact, likeSql(jobs.jobNumber, term), likeSql(jobs.name, term), likeSql(sql`coalesce(${jobs.description}, '')`, term)),
    orderBy: [
      sql`(case when ${exact} then 0 when ${likeSql(jobs.jobNumber, term)} then 1 when ${likeSql(jobs.name, term)} then 2 else 3 end)`,
      desc(jobs.lastActivityAt),
      asc(jobs.id),
    ],
    limit,
  });
  const lower = term.toLowerCase();
  add(direct, (r) =>
    r.job.jobNumber.toLowerCase().includes(lower) || (exactRaw && exactRaw.job.id === r.job.id)
      ? "number"
      : r.job.name.toLowerCase().includes(lower)
        ? "name"
        : "description",
  );

  if (hits.size < limit) {
    const noteKinds = isManagement(ctx) ? undefined : ne(jobNotes.kind, "internal");
    const noteMatch = db
      .select({ one: sql`1` })
      .from(jobNotes)
      .where(and(eq(jobNotes.jobId, jobs.id), eq(jobNotes.organisationId, org), isNull(jobNotes.archivedAt), noteKinds, likeSql(jobNotes.body, term)));
    add(selectRawJobs(db, ctx, { where: exists(noteMatch), orderBy: [desc(jobs.lastActivityAt), asc(jobs.id)], limit }), () => "note");
  }
  if (hits.size < limit) {
    const commentMatch = db
      .select({ one: sql`1` })
      .from(jobComments)
      .where(and(eq(jobComments.jobId, jobs.id), eq(jobComments.organisationId, org), isNull(jobComments.deletedAt), likeSql(jobComments.body, term)));
    add(selectRawJobs(db, ctx, { where: exists(commentMatch), orderBy: [desc(jobs.lastActivityAt), asc(jobs.id)], limit }), () => "comment");
  }

  /* ---------------- clients / projects ---------------- */
  // Probe with hasVisibleJob: false → true only for roles whose scope is the whole organisation.
  const orgWide = can(ctx, "client.view", { organisationId: org, hasVisibleJob: false });
  const visibleJobFor = (col: SQL): SQL =>
    exists(
      db
        .select({ one: sql`1` })
        .from(jobs)
        .where(and(sql`${jobs.clientId} = ${col}`, visibleJobsWhere(ctx))),
    );

  const clientRows = db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.organisationId, org), likeSql(clients.name, term), orgWide ? undefined : visibleJobFor(sql`${clients.id}`)))
    .orderBy(sql`(${clients.archivedAt} is not null)`, sql`${clients.name} collate nocase`)
    .limit(limit)
    .all();

  const projectVisible = (): SQL =>
    exists(
      db
        .select({ one: sql`1` })
        .from(jobs)
        .where(and(sql`${jobs.projectId} = ${projects.id}`, visibleJobsWhere(ctx))),
    );
  const projectRows = db
    .select({ id: projects.id, name: projects.name, clientId: projects.clientId, clientName: clients.name })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .where(
      and(
        eq(projects.organisationId, org),
        or(likeSql(projects.name, term), likeSql(sql`coalesce(${projects.address}, '')`, term)),
        can(ctx, "project.view", { organisationId: org, hasVisibleJob: false }) ? undefined : projectVisible(),
      ),
    )
    .orderBy(sql`(${projects.archivedAt} is not null)`, sql`${projects.name} collate nocase`)
    .limit(limit)
    .all();

  /* ---------------- people ---------------- */
  const userMatch = isManagement(ctx) ? or(likeSql(users.name, term), likeSql(users.email, term)) : likeSql(users.name, term);
  const userRows = can(ctx, "team.view_members")
    ? db
        .select({ id: users.id, name: users.name, role: users.role, avatarColour: users.avatarColour, isActive: users.isActive })
        .from(users)
        .where(and(eq(users.organisationId, org), eq(users.isActive, true), isNull(users.anonymisedAt), userMatch))
        .orderBy(sql`${users.name} collate nocase`)
        .limit(limit)
        .all()
    : [];

  return {
    query: term,
    jobs: [...hits.values()],
    clients: clientRows.map((c) => ({ id: c.id, name: c.name })),
    projects: projectRows.map((p) => ({ id: p.id, name: p.name, clientId: p.clientId, client: { id: p.clientId, name: p.clientName } })),
    users: userRows.map((u) => ({ ...u })),
    exactJob: exactRaw ? { id: exactRaw.job.id, jobNumber: exactRaw.job.jobNumber, name: exactRaw.job.name } : null,
  };
}
