/**
 * Calendar (ARCHITECTURE.md §10 `/workspace/calendar`).
 *
 * Event kinds: shoot (jobs.shoot_date), due (editing deadline), review_due,
 * delivery_due and revision_due (open revisions' due_date). Visible,
 * non-cancelled jobs only. The UI colours events by status / priority /
 * overdue / editor from the payload (`job.status.colour`, `job.priority`,
 * `isOverdue`, `job.editor.avatarColour`).
 *
 * Overdue per kind: due → DEADLINE_BOUND ∧ due < now; review_due →
 * REVIEWER_HOLDS ∧ review_due < now; delivery_due → not yet delivered /
 * completed ∧ delivery_due < now; revision_due → revision still open ∧ due < now.
 */
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { jobRevisions, jobs } from "@/db/schema";
import { CATEGORY_GROUPS } from "@/lib/constants";
import { addCivilDays, civilDate, endOfCivilDayIso, startOfCivilDayIso, todayCivil } from "@/lib/dates";
import { isPastDue } from "@/lib/metrics";
import type { AuthContext, CalendarEvent, CalendarEventKind } from "@/lib/types";
import { parseInput } from "@/server/services/_shared";
import { jobFiltersWhere, JobListFiltersSchema } from "./jobs";
import { loadOrgSettingsRow, orgDayBounds, selectRawJobs, type RawJobRow } from "./scope";

export const CALENDAR_EVENT_KINDS: readonly CalendarEventKind[] = ["shoot", "due", "review_due", "delivery_due", "revision_due"];
const MAX_JOBS = 2000;

const one = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), item);
const bound = one(z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "Expected YYYY-MM-DD or an ISO timestamp").optional());

export const CalendarQuerySchema = JobListFiltersSchema.extend({
  /** Civil date (inclusive, org tz) or ISO instant (exclusive). Default: start of this month − 7 days. */
  from: bound,
  /** Civil date (inclusive, org tz) or ISO instant (inclusive). Default: from + 42 days. */
  to: bound,
  kinds: z.preprocess((v) => {
    if (v === undefined || v === null || v === "") return undefined;
    const arr = (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === "string" ? x.split(",") : [x]));
    return arr.length ? arr : undefined;
  }, z.array(z.enum(["shoot", "due", "review_due", "delivery_due", "revision_due"])).optional()),
});
export type CalendarQueryInput = z.input<typeof CalendarQuerySchema>;

function rangeOf(ctx: AuthContext, from: string | undefined, to: string | undefined, now: string): { from: string; to: string } {
  const tz = ctx.settings.timezone;
  const isCivil = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const defaultStart = addCivilDays(`${todayCivil(tz, new Date(now)).slice(0, 8)}01`, -7);
  const fromCivil = from ? (isCivil(from) ? from : (civilDate(from, tz) ?? defaultStart)) : defaultStart;
  const fromIso = from && !isCivil(from) ? from : startOfCivilDayIso(fromCivil, tz);
  const toIso = to ? (isCivil(to) ? endOfCivilDayIso(to, tz) : to) : startOfCivilDayIso(addCivilDays(fromCivil, 42), tz);
  return { from: fromIso, to: toIso };
}

function jobPart(raw: RawJobRow): CalendarEvent["job"] {
  const j = raw.job;
  return {
    id: j.id,
    jobNumber: j.jobNumber,
    name: j.name,
    priority: j.priority,
    statusCategory: j.statusCategory,
    status: { ...raw.status },
    editor: raw.editor ? { ...raw.editor } : null,
    photographer: raw.photographer ? { ...raw.photographer } : null,
  };
}

/**
 * Calendar events between `from` and `to` (civil days inclusive, org tz).
 * Every date kind is an end-of-day instant, so the instant window is (from, to].
 */
export async function getCalendarEvents(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<CalendarEvent[]> {
  const q = parseInput(CalendarQuerySchema, input ?? {});
  const now = ctx.now();
  const range = rangeOf(ctx, q.from, q.to, now);
  const kinds = new Set<CalendarEventKind>(q.kinds?.length ? q.kinds : CALENDAR_EVENT_KINDS);
  const bounds = orgDayBounds(ctx, now, (await loadOrgSettingsRow(db, ctx))?.weekStartsOn ?? 1);
  // Deadlines / shoot dates are end-of-civil-day instants: civil day d is stored in
  // (start(d), end(d)], so the window is (from, to] (holds for both end-of-day encodings).
  const inRangeDeadline = (col: PgColumn): SQL => and(gt(col, range.from), lte(col, range.to)) as SQL;

  const dateParts: SQL[] = [];
  if (kinds.has("shoot")) dateParts.push(inRangeDeadline(jobs.shootDate));
  if (kinds.has("due")) dateParts.push(inRangeDeadline(jobs.dueDate));
  if (kinds.has("review_due")) dateParts.push(inRangeDeadline(jobs.reviewDueDate));
  if (kinds.has("delivery_due")) dateParts.push(inRangeDeadline(jobs.deliveryDueDate));

  const filterWhere = jobFiltersWhere(ctx, q, bounds);
  const base = and(filterWhere, ne(jobs.statusCategory, "cancelled"));

  const events: CalendarEvent[] = [];
  const inWindow = (at: string | null): at is string => at !== null && at > range.from && at <= range.to;

  if (dateParts.length > 0) {
    const raws = await selectRawJobs(db, ctx, { where: and(base, or(...dateParts)), limit: MAX_JOBS });
    for (const raw of raws) {
      const j = raw.job;
      const job = jobPart(raw);
      if (kinds.has("shoot") && inWindow(j.shootDate)) {
        events.push({ id: `${j.id}:shoot`, kind: "shoot", at: j.shootDate, job, isOverdue: false });
      }
      if (kinds.has("due") && inWindow(j.dueDate)) {
        events.push({
          id: `${j.id}:due`,
          kind: "due",
          at: j.dueDate,
          job,
          isOverdue: CATEGORY_GROUPS.DEADLINE_BOUND.includes(j.statusCategory) && isPastDue(j.dueDate, now),
        });
      }
      if (kinds.has("review_due") && inWindow(j.reviewDueDate)) {
        events.push({
          id: `${j.id}:review_due`,
          kind: "review_due",
          at: j.reviewDueDate,
          job,
          isOverdue: CATEGORY_GROUPS.REVIEWER_HOLDS.includes(j.statusCategory) && isPastDue(j.reviewDueDate, now),
        });
      }
      if (kinds.has("delivery_due") && inWindow(j.deliveryDueDate)) {
        const delivered = j.statusCategory === "delivered" || j.statusCategory === "completed";
        events.push({ id: `${j.id}:delivery_due`, kind: "delivery_due", at: j.deliveryDueDate, job, isOverdue: !delivered && isPastDue(j.deliveryDueDate, now) });
      }
    }
  }

  if (kinds.has("revision_due")) {
    const revs = await db
      .select({ id: jobRevisions.id, jobId: jobRevisions.jobId, dueDate: jobRevisions.dueDate, revisionNumber: jobRevisions.revisionNumber, resolvedAt: jobRevisions.resolvedAt })
      .from(jobRevisions)
      .where(and(eq(jobRevisions.organisationId, ctx.organisationId), isNull(jobRevisions.resolvedAt), inRangeDeadline(jobRevisions.dueDate)))
      .orderBy(asc(jobRevisions.dueDate), asc(jobRevisions.id));
    if (revs.length > 0) {
      const raws = await selectRawJobs(db, ctx, { where: and(base, inArray(jobs.id, [...new Set(revs.map((r) => r.jobId))])) });

      const byId = new Map(raws.map((r) => [r.job.id, r]));
      for (const r of revs) {
        const raw = byId.get(r.jobId);
        if (!raw || !r.dueDate) continue;
        events.push({
          id: `${r.id}:revision_due`,
          kind: "revision_due",
          at: r.dueDate,
          job: jobPart(raw),
          isOverdue: isPastDue(r.dueDate, now),
          revisionNumber: r.revisionNumber,
        });
      }
    }
  }

  events.sort((a, b) => a.at.localeCompare(b.at) || CALENDAR_EVENT_KINDS.indexOf(a.kind) - CALENDAR_EVENT_KINDS.indexOf(b.kind) || a.job.jobNumber.localeCompare(b.job.jobNumber));
  return events;
}
