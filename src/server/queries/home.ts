/**
 * Home for the owner / co-owners and for an extra photographer
 * (docs/SIMPLIFICATION-PLAN.md §6). Fixed layout, no customise:
 *
 *   topline        "3 to check · 2 late · 1 needs an editor"
 *   readyToCheck   Ready-to-check jobs, oldest send first, with Approve / Ask
 *                  for changes (Approve asks "Approve & send / Approve only"
 *                  when the client uses the portal, §12.2; owners who edited
 *                  the job themselves confirm first, §12.3)
 *   needsAttention late · no editor yet (shot before today) · open question
 *                  from an editor · unanswered message from the client — one
 *                  row per job, capped (needsAttentionMore says how many more)
 *   yourEditors    owners only — On their desk · Late · On time this month
 *   comingUp       shoots and due dates in the next 7 days
 *
 * Scope = the viewer's visible jobs (`visibleJobsWhere`): everything for the
 * owner, their own shoots for an extra photographer. A photographer without
 * Review submissions sees "<owner> will check this" instead of buttons (§12.4).
 * Editors use My jobs (`getMyJobs`); clients → 403.
 */
import { and, asc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { clients, jobComments, jobs, organisationSettings, users } from "@/db/schema";
import { QUESTION_COMMENT_KINDS } from "@/lib/constants";
import { addCivilDays, civilDate, endOfCivilDayIso } from "@/lib/dates";
import type { AuthContext, ComingUpItem, HomeEditorRow, NeedsAttentionReason, NeedsAttentionRow, OwnerHome, ReadyToCheckCard, UserRef } from "@/lib/types";
import { STAGE_META } from "@/lib/stages";
import { can, isAdmin, workedOnJob } from "@/server/auth/permissions";
import { loadJobRefs } from "@/server/auth/job-ref";
import { ForbiddenError } from "@/server/errors";
import { computeEditorRows } from "./editors";
import { activeStageWhere, countSimpleRows, lateWhere, selectSimpleRows, simpleBounds, stageWhere } from "./jobsSimple";
import { loadUserRefs } from "./metrics";
import { assertStaffRead, type OrgDayBounds } from "./scope";
import { loadSimplerNoticeDismissedAt } from "./simpleColumns";

export const HOME_LIST_LIMIT = 20;
/** Needs attention shows at most this many late / no-editor jobs (questions and client messages always show). */
export const NEEDS_ATTENTION_LIMIT = 10;
export const NEEDS_ATTENTION_THREADS_LIMIT = 20;
export const COMING_UP_DAYS = 7;
export const EXCERPT_LENGTH = 200;

const excerpt = (body: string): string => (body.length > EXCERPT_LENGTH ? `${body.slice(0, EXCERPT_LENGTH - 1)}…` : body);

/* ------------------------------------------------------------------ */
/*  Access                                                             */
/* ------------------------------------------------------------------ */

/** Owners, co-owners and photographers. Editors have My jobs; clients the portal. */
export function assertHomeViewer(ctx: AuthContext): void {
  assertStaffRead(ctx);
  if (ctx.isSystem || ctx.role !== "photographer" || ctx.userId === null) throw new ForbiddenError("app.access", "Home is for photographers; editors use My jobs");
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Primary owner's name (who "will check this" for a photographer without Review submissions). */
async function ownerName(db: DbLike, ctx: AuthContext): Promise<string | null> {
  const row = (
    await db
      .select({ name: users.name })
      .from(organisationSettings)
      .innerJoin(users, eq(users.id, organisationSettings.primaryOwnerUserId))
      .where(eq(organisationSettings.organisationId, ctx.organisationId))
  )[0];
  return row?.name ?? null;
}

/** Client ids of the org that use the portal. */
async function portalClientIds(db: DbLike, ctx: AuthContext, ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.organisationId, ctx.organisationId), inArray(clients.id, unique), eq(clients.portalEnabled, true)));
  return new Set(rows.map((r) => r.id));
}

/* ------------------------------------------------------------------ */
/*  Ready to check                                                     */
/* ------------------------------------------------------------------ */

/** Visible Ready-to-check jobs, oldest send first, with the viewer's check rights. */
export async function readyToCheckCards(db: DbLike, ctx: AuthContext, bounds: OrgDayBounds, limit = HOME_LIST_LIMIT): Promise<ReadyToCheckCard[]> {
  const sentAtSql = sql`coalesce(${jobs.lastSubmittedAt}, ${jobs.statusEnteredAt})`;
  const rows = await selectSimpleRows(db, ctx, bounds, { where: stageWhere("ready_to_check"), orderBy: [sql`${sentAtSql} asc`, asc(jobs.id)], limit });
  if (rows.length === 0) return [];
  const refs = await loadJobRefs(
    db,
    ctx,
    rows.map((r) => r.id),
  );
  const portal = await portalClientIds(
    db,
    ctx,
    rows.map((r) => r.client.id),
  );
  const owner = await ownerName(db, ctx);
  const admin = isAdmin(ctx);
  return rows.map((job) => {
    const ref = refs.get(job.id)?.ref;
    const edited = ref !== undefined && workedOnJob(ctx, ref);
    // Owners / co-owners may approve a job they edited themselves after confirming (§12.3); everyone else follows `job.approve`.
    const canCheck = ref !== undefined && (admin || can(ctx, "job.approve", ref));
    const sentAt = job.sentAt ?? job.statusEnteredAt;
    return {
      job,
      sentAt,
      sentAgoSeconds: Math.max(0, Math.floor((Date.parse(bounds.now) - Date.parse(sentAt)) / 1000)),
      round: job.round,
      finishedLink: job.finishedLink,
      canCheck,
      selfReviewNeedsConfirm: canCheck && admin && edited,
      checkedBy: canCheck ? null : (owner ?? "The owner"),
      shareQuestion: portal.has(job.client.id),
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Needs attention                                                    */
/* ------------------------------------------------------------------ */

interface WaitingThread {
  jobId: string;
  kind: "question" | "client_message";
  author: UserRef;
  excerpt: string;
  since: string;
}

/**
 * Open editor questions (no reply from staff other than the asker) and client
 * feedback threads whose latest message is from the client, on the given jobs.
 */
async function waitingThreads(db: DbLike, ctx: AuthContext, jobIds: readonly string[]): Promise<WaitingThread[]> {
  if (jobIds.length === 0) return [];
  const roots = await db
    .select({ id: jobComments.id, jobId: jobComments.jobId, kind: jobComments.kind, authorUserId: jobComments.authorUserId, body: jobComments.body, createdAt: jobComments.createdAt })
    .from(jobComments)
    .where(
      and(
        eq(jobComments.organisationId, ctx.organisationId),
        inArray(jobComments.jobId, [...jobIds]),
        isNull(jobComments.parentCommentId),
        isNull(jobComments.deletedAt),
        inArray(jobComments.kind, [...QUESTION_COMMENT_KINDS, "client_feedback"]),
      ),
    )
    .orderBy(asc(jobComments.createdAt), asc(jobComments.id));
  if (roots.length === 0) return [];
  const replies = await db
    .select({ rootCommentId: jobComments.rootCommentId, authorUserId: jobComments.authorUserId, body: jobComments.body, createdAt: jobComments.createdAt })
    .from(jobComments)
    .where(
      and(
        eq(jobComments.organisationId, ctx.organisationId),
        inArray(jobComments.rootCommentId, roots.map((r) => r.id)),
        isNull(jobComments.deletedAt),
        sql`${jobComments.parentCommentId} is not null`,
      ),
    )
    .orderBy(asc(jobComments.createdAt), asc(jobComments.id));
  const authorIds = [...new Set([...roots.map((r) => r.authorUserId), ...replies.map((r) => r.authorUserId)])];
  const refs = await loadUserRefs(db, ctx, authorIds);
  const roleOf = (id: string) => refs.get(id)?.role;
  const out: WaitingThread[] = [];
  for (const root of roots) {
    const thread = replies.filter((r) => r.rootCommentId === root.id);
    const author = refs.get(root.authorUserId);
    if (!author) continue;
    const last = thread.at(-1) ?? { authorUserId: root.authorUserId, body: root.body, createdAt: root.createdAt };
    if (root.kind === "client_feedback") {
      if (roleOf(last.authorUserId) !== "client") continue;
      out.push({ jobId: root.jobId, kind: "client_message", author, excerpt: excerpt(last.body), since: last.createdAt });
    } else {
      if (roleOf(root.authorUserId) !== "editor") continue; // "Question from Sam": only editors' questions
      const answered = thread.some((r) => r.authorUserId !== root.authorUserId && roleOf(r.authorUserId) !== "client");
      if (answered) continue;
      out.push({ jobId: root.jobId, kind: "question", author, excerpt: excerpt(last.body), since: last.createdAt });
    }
  }
  return out;
}

const REASON_ORDER = { late: 0, no_editor: 1, question: 2, client_message: 3 } as const;
/** Inside one row the reason with the button leads: "No editor yet · 1 day late" [Assign editor]. */
const IN_ROW_ORDER = { no_editor: 0, late: 1, question: 2, client_message: 3 } as const;

export interface NeedsAttention {
  rows: NeedsAttentionRow[];
  /** Late / no-editor jobs cut by the cap. */
  more: number;
}

/**
 * One list with plain reasons, ONE ROW PER JOB (a job that is both late and without an editor reads
 * "No editor yet · 1 day late" and keeps its [Assign editor] button). "with <name>" is only said when
 * the job is actually with an editor — never "with You" for a job nobody is editing. Late / no-editor
 * rows are capped at `limit` (the footer links to the Late filter in Jobs); open questions and client
 * messages always show. Empty → "Nothing needs you right now."
 */
export async function needsAttentionRows(db: DbLike, ctx: AuthContext, bounds: OrgDayBounds, limit = NEEDS_ATTENTION_LIMIT): Promise<NeedsAttention> {
  const tz = ctx.settings.timezone;
  const byJob = new Map<string, NeedsAttentionRow>();
  const add = (job: NeedsAttentionRow["job"], reason: NeedsAttentionReason, since: string) => {
    const row = byJob.get(job.id);
    if (!row) {
      byJob.set(job.id, { job, reason, also: [], since });
      return;
    }
    const all = [row.reason, ...row.also, reason].sort((a, b) => IN_ROW_ORDER[a.kind] - IN_ROW_ORDER[b.kind]);
    row.reason = all[0];
    row.also = all.slice(1);
    if (since < row.since) row.since = since;
  };

  const late = await selectSimpleRows(db, ctx, bounds, { where: lateWhere(bounds), orderBy: [asc(jobs.dueDate), asc(jobs.id)], limit: 500 });
  for (const job of late) {
    const withEditor = STAGE_META[job.stage.stage].waitingOn === "editor" ? (job.editor?.name ?? null) : null;
    add(job, { kind: "late", daysLate: Math.max(1, -(job.due.daysFromToday ?? 0)), withName: withEditor }, job.due.dueDate ?? job.statusEnteredAt);
  }
  // No editor yet, shot before today (shoot day ≤ yesterday).
  const noEditor = await selectSimpleRows(db, ctx, bounds, {
    where: and(stageWhere("needs_editor"), isNull(jobs.editorId), lte(jobs.shootDate, bounds.startOfToday)) as SQL,
    orderBy: [asc(jobs.shootDate), asc(jobs.id)],
    limit: 500,
  });
  for (const job of noEditor) {
    const shot = job.shootDate ? civilDate(new Date(Date.parse(job.shootDate) - 1), tz) : null;
    add(job, { kind: "no_editor", shotCivilDate: shot }, job.shootDate ?? job.statusEnteredAt);
  }
  // Questions / client messages on visible, non-cancelled jobs.
  const openJobs = await selectSimpleRows(db, ctx, bounds, { where: sql`${jobs.statusCategory} <> 'cancelled'`, limit: 2000 });
  const byId = new Map(openJobs.map((j) => [j.id, j]));
  for (const t of await waitingThreads(db, ctx, [...byId.keys()])) {
    const job = byId.get(t.jobId);
    if (!job) continue;
    add(job, t.kind === "question" ? { kind: "question", from: t.author, excerpt: t.excerpt, since: t.since } : { kind: "client_message", excerpt: t.excerpt, since: t.since }, t.since);
  }

  const severity = (r: NeedsAttentionRow) => Math.min(...[r.reason, ...r.also].map((x) => REASON_ORDER[x.kind]));
  const rows = [...byJob.values()].sort((a, b) => severity(a) - severity(b) || a.since.localeCompare(b.since) || a.job.jobNumber.localeCompare(b.job.jobNumber));
  const hasThread = (r: NeedsAttentionRow) => [r.reason, ...r.also].some((x) => x.kind === "question" || x.kind === "client_message");
  const jobRows = rows.filter((r) => !hasThread(r));
  const threadRows = rows.filter(hasThread).slice(0, NEEDS_ATTENTION_THREADS_LIMIT);
  const kept = new Set([...jobRows.slice(0, limit), ...threadRows]);
  return { rows: rows.filter((r) => kept.has(r)), more: Math.max(0, jobRows.length - limit) };
}

/* ------------------------------------------------------------------ */
/*  Coming up                                                          */
/* ------------------------------------------------------------------ */

/** Shoots and due dates (active stages) from today through the next COMING_UP_DAYS days. */
export async function comingUpItems(db: DbLike, ctx: AuthContext, bounds: OrgDayBounds, limit = HOME_LIST_LIMIT): Promise<ComingUpItem[]> {
  const tz = ctx.settings.timezone;
  const from = bounds.startOfToday;
  const to = endOfCivilDayIso(addCivilDays(bounds.today, COMING_UP_DAYS - 1), tz);
  const within = (col: typeof jobs.shootDate | typeof jobs.dueDate) => and(gt(col, from), lte(col, to)) as SQL;
  const rows = await selectSimpleRows(db, ctx, bounds, {
    where: and(sql`${jobs.statusCategory} <> 'cancelled'`, or(within(jobs.shootDate), and(activeStageWhere(), within(jobs.dueDate)))) as SQL,
    orderBy: [sql`least(${jobs.shootDate}, ${jobs.dueDate}) asc nulls last`, asc(jobs.jobNumber)],
    limit: limit * 2,
  });
  const inWindow = (at: string | null): at is string => at !== null && at > from && at <= to;
  const out: ComingUpItem[] = [];
  for (const job of rows) {
    if (inWindow(job.shootDate)) out.push({ kind: "shoot", at: job.shootDate, civilDate: civilDate(new Date(Date.parse(job.shootDate) - 1), tz) ?? bounds.today, job });
    if (job.stage.active && inWindow(job.due.dueDate)) out.push({ kind: "due", at: job.due.dueDate, civilDate: job.due.civilDate ?? bounds.today, job });
  }
  out.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === b.kind ? 0 : a.kind === "shoot" ? -1 : 1) || a.job.jobNumber.localeCompare(b.job.jobNumber));
  return out.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/*  getOwnerHome                                                       */
/* ------------------------------------------------------------------ */

/** The Home screen for the viewer (owner / co-owner: everything; extra photographer: their shoots). */
export async function getOwnerHome(db: DbLike, ctx: AuthContext): Promise<OwnerHome> {
  assertHomeViewer(ctx);
  const now = ctx.now();
  const bounds = await simpleBounds(db, ctx, now);
  const me = ctx.userId as string;
  const viewer = (await loadUserRefs(db, ctx, [me])).get(me);
  const admin = isAdmin(ctx);

  const readyToCheck = await readyToCheckCards(db, ctx, bounds);
  const toCheck = await countSimpleRows(db, ctx, stageWhere("ready_to_check"));
  const late = await countSimpleRows(db, ctx, lateWhere(bounds));
  const needsEditor = await countSimpleRows(db, ctx, stageWhere("needs_editor"));
  const total = await countSimpleRows(db, ctx);

  const yourEditors: HomeEditorRow[] | null = admin
    ? (await computeEditorRows(db, ctx, "this_month", now)).map((r) => ({
        editor: r.editor,
        onDesk: r.onDesk,
        lateNow: r.lateNow,
        onTimePctThisMonth: r.onTimePct,
        notEnough: r.notEnough,
        usualCapacity: r.usualCapacity,
        full: r.full,
      }))
    : null;

  const attention = await needsAttentionRows(db, ctx, bounds);
  return {
    viewer: { id: me, name: viewer?.name ?? "", isAdmin: admin, canReview: admin || ctx.canReviewSubmissions },
    topline: { toCheck, late, needsEditor },
    readyToCheck,
    needsAttention: attention.rows,
    needsAttentionMore: attention.more,
    yourEditors,
    comingUp: await comingUpItems(db, ctx, bounds),
    simplerNotice: (await loadSimplerNoticeDismissedAt(db, ctx)) === null,
    emptyStudio: total === 0,
    asOf: now,
  };
}

