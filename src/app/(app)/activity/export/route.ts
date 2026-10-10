/**
 * GET /activity/export?<same params as /activity> → text/csv of the
 * filtered feed (newest first, capped at EXPORT_MAX_ROWS). Same scoping as
 * the page (listActivity), gated by `export.csv`.
 */
import { eventGroupsFor } from "@/components/activity/event-groups";
import { compactQuery, parseActivityPageFilters } from "@/components/activity/page-filters";
import { buildCsv, csvFileName } from "@/lib/csv";
import { formatDateTime } from "@/lib/dates";
import type { ActivityFeedItem } from "@/lib/types";
import { getDb } from "@/db";
import { assertCan, can } from "@/server/auth/permissions";
import { requireContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/errors";
import { handle } from "@/server/http";
import { listActivity } from "@/server/queries/activity";
import { getJobRowByNumber } from "@/server/queries/jobs";

const EXPORT_MAX_ROWS = 5000;
const PAGE = 200;

function snapshot(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export const GET = handle(async (req: Request) => {
  const ctx = await requireContext();
  assertCan(ctx, "activity.view_global");
  assertCan(ctx, "export.csv");
  const db = getDb();
  const tz = ctx.settings.timezone;
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const groups = eventGroupsFor(can(ctx, "activity.view_management_events")).map((g) => g.key);
  const filters = parseActivityPageFilters(sp, tz, groups);

  let jobMissing = false;
  if (filters.jobNumber && !filters.jobId) {
    try {
      filters.query.jobId = (await getJobRowByNumber(db, ctx, filters.jobNumber)).id;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      jobMissing = true;
    }
  }

  const items: ActivityFeedItem[] = [];
  if (!jobMissing) {
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof listActivity>> = await listActivity(db, ctx, { ...compactQuery(filters.query), limit: PAGE, ...(cursor ? { cursor } : {}) });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && items.length < EXPORT_MAX_ROWS);
  }

  const rows = items.slice(0, EXPORT_MAX_ROWS).map((i) => [
    formatDateTime(i.createdAt, tz),
    i.createdAt,
    i.actor?.name ?? (i.isSystem ? "System" : ""),
    i.eventType,
    i.sentence ?? i.summary,
    i.job?.jobNumber ?? "",
    i.job?.name ?? "",
    snapshot(i.previousValue),
    snapshot(i.newValue),
    i.id,
  ]);
  const csv = buildCsv(
    ["Time (studio)", "Timestamp (UTC)", "Who", "Event", "What happened", "Job number", "Job", "Before", "After", "Event id"],
    rows,
    { bom: true },
  );
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${csvFileName(`activity-${stamp}`)}"`,
      "cache-control": "no-store",
    },
  });
});
