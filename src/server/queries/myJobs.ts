/**
 * My jobs — the editor's only home (docs/SIMPLIFICATION-PLAN.md §6).
 *
 *   "Hi Sam. Next up: 8 Penrose St, due today."
 *   1. Changes asked (red, do these first) — each card quotes the request
 *   2. Late
 *   3. To do, sorted by due date ("New" / "Editing")
 *   4. Waiting for <owner> to check (read only)
 *   5. Done recently (last 30 days)
 *   footer: "This month: 14 finished · 93% on time · 2 needed changes" — the
 *   SAME formulas the owner sees on the Editors page (src/lib/editorMetrics.ts).
 *
 * Scope: jobs the editor holds (`editor_id = me`), always inside
 * `visibleJobsWhere`. Sections are exclusive (first match wins). Only
 * editors: photographers use Home, clients the portal (403).
 */
import { and, asc, desc, eq, gte, isNull, sql, type SQL } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { jobRevisions, jobs } from "@/db/schema";
import { periodRange } from "@/lib/editorMetrics";
import { categoriesForStage, nextStepFor } from "@/lib/stages";
import type { AuthContext, ChangesAskedNote, MyJobCard, MyJobs, MyJobsFooter, SimpleJobRow } from "@/lib/types";
import { ForbiddenError } from "@/server/errors";
import { fiveNumbers } from "./editors";
import { lateWhere, selectSimpleRows, simpleBounds, stageWhere } from "./jobsSimple";
import { approvedJobsInRange, loadUserRefs } from "./metrics";
import { assertStaffRead, categoryIn, type OrgDayBounds } from "./scope";

export const DONE_RECENTLY_DAYS = 30;
export const MY_JOBS_MAX = 500;
const DAY_MS = 86_400_000;

export function assertMyJobsViewer(ctx: AuthContext): void {
  assertStaffRead(ctx);
  if (ctx.isSystem || ctx.role !== "editor" || ctx.userId === null) throw new ForbiddenError("app.access", "My jobs is for editors");
}

/** The latest open change request per job (round, who, when, text). */
async function openRequests(db: DbLike, ctx: AuthContext, jobIds: readonly string[]): Promise<Map<string, ChangesAskedNote>> {
  const out = new Map<string, ChangesAskedNote>();
  if (jobIds.length === 0) return out;
  const rows = await db
    .select({
      jobId: jobRevisions.jobId,
      round: jobRevisions.revisionNumber,
      requestedBy: jobRevisions.requestedByUserId,
      requestedAt: jobRevisions.requestedAt,
      description: jobRevisions.description,
      reason: jobRevisions.reason,
    })
    .from(jobRevisions)
    .where(and(eq(jobRevisions.organisationId, ctx.organisationId), sql`${jobRevisions.jobId} in (${sql.join(jobIds.map((id) => sql`${id}`), sql`, `)})`, isNull(jobRevisions.resolvedAt)))
    .orderBy(desc(jobRevisions.revisionNumber));
  const people = await loadUserRefs(
    db,
    ctx,
    rows.map((r) => r.requestedBy),
  );
  for (const r of rows) {
    if (out.has(r.jobId)) continue;
    const who = people.get(r.requestedBy);
    if (!who) continue;
    out.set(r.jobId, { round: r.round, who, when: r.requestedAt, text: r.description, reason: r.reason });
  }
  return out;
}

function card(job: SimpleJobRow, changesAsked: ChangesAskedNote | null, toDoLabel: MyJobCard["toDoLabel"]): MyJobCard {
  return { job, toDoLabel, changesAsked, nextStep: nextStepFor(job.stage.stage, "editor", job.statusCategory), hasFinishedLink: job.finishedLink !== null };
}

/** The editor's own five numbers for the current month (same formulas as the Editors page). */
export async function myFooter(db: DbLike, ctx: AuthContext, now: string): Promise<MyJobsFooter> {
  const me = ctx.userId ?? "";
  const range = periodRange("this_month", ctx.settings.timezone, now);
  // Visible scope: the jobs I hold or held; credit follows the approving editor exactly as on the Editors page.
  const approved = (await approvedJobsInRange(db, ctx, { from: range.from, to: range.to }, { scope: "visible" })).filter((j) => j.approvingEditorId === me);
  const n = fiveNumbers(undefined, approved, ctx.settings.timezone);
  return { finished: n.finished, onTimePct: n.onTimePct, neededChangesPct: n.neededChangesPct, notEnough: n.notEnough };
}

/** My jobs for the signed-in editor. */
export async function getMyJobs(db: DbLike, ctx: AuthContext): Promise<MyJobs> {
  assertMyJobsViewer(ctx);
  const now = ctx.now();
  const me = ctx.userId as string;
  const bounds: OrgDayBounds = await simpleBounds(db, ctx, now);
  const mine = eq(jobs.editorId, me);
  const held = await selectSimpleRows(db, ctx, bounds, {
    where: and(mine, categoryIn([...categoriesForStage("with_editor"), ...categoriesForStage("changes_asked"), ...categoriesForStage("ready_to_check")])) as SQL,
    orderBy: [sql`${jobs.dueDate} asc nulls last`, asc(jobs.statusEnteredAt), asc(jobs.id)],
    limit: MY_JOBS_MAX,
  });
  const requests = await openRequests(
    db,
    ctx,
    held.filter((j) => j.stage.stage === "changes_asked").map((j) => j.id),
  );
  const changesAsked: MyJobCard[] = [];
  const late: MyJobCard[] = [];
  const toDo: MyJobCard[] = [];
  const waitingForCheck: MyJobCard[] = [];
  for (const job of held) {
    if (job.stage.stage === "changes_asked") changesAsked.push(card(job, requests.get(job.id) ?? null, null));
    else if (job.stage.stage === "ready_to_check") waitingForCheck.push(card(job, null, null));
    else if (job.due.late) late.push(card(job, null, null));
    else toDo.push(card(job, null, job.stage.subLabel === "editing" ? "editing" : "new"));
  }
  const since = new Date(Date.parse(now) - DONE_RECENTLY_DAYS * DAY_MS).toISOString();
  const doneRows = await selectSimpleRows(db, ctx, bounds, {
    where: and(mine, stageWhere("done"), gte(sql`coalesce(${jobs.approvedAt}, ${jobs.statusEnteredAt})`, since)) as SQL,
    orderBy: [sql`coalesce(${jobs.approvedAt}, ${jobs.statusEnteredAt}) desc`, desc(jobs.id)],
    limit: MY_JOBS_MAX,
  });
  const viewer = (await loadUserRefs(db, ctx, [me])).get(me);
  return {
    viewer: { id: me, name: viewer?.name ?? "" },
    nextUp: changesAsked[0] ?? late[0] ?? toDo[0] ?? null,
    changesAsked,
    late,
    toDo,
    waitingForCheck,
    doneRecently: doneRows.map((job) => card(job, null, null)),
    thisMonth: await myFooter(db, ctx, now),
    asOf: now,
  };
}

/** SQL for "jobs on my desk that are late" (the editor's Late section) — shared with notifications / badges. */
export function myLateWhere(ctx: AuthContext, bounds: OrgDayBounds): SQL {
  return and(eq(jobs.editorId, ctx.userId ?? ""), lateWhere(bounds)) as SQL;
}
