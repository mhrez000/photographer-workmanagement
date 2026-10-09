/**
 * Automation rules + run history (ARCHITECTURE.md §7, §10
 * `/settings/automations`). automation.manage / automation.view_runs = O/M.
 * JSON columns are re-validated on read (`parseJsonColumn`, fallback on drift).
 */
import { and, asc, desc, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { activityEvents, automationRuns, automations, jobs } from "@/db/schema";
import { AUTOMATION_RUN_STATUSES } from "@/lib/constants";
import type { Automation, AuthContext, AutomationDetail, AutomationListItem, AutomationRunCounts, AutomationRunView, Paginated } from "@/lib/types";
import {
  AutomationActionResultsSchema,
  AutomationActionsSchema,
  AutomationConditionsSchema,
  AutomationTriggerSchema,
  parseJsonColumn,
} from "@/lib/validation/json";
import { assertCan, can } from "@/server/auth/permissions";
import { loadAutomationInOrg, parseInput } from "@/server/services/_shared";
import { loadUserRefs } from "./metrics";

export const RUNS_DEFAULT_LIMIT = 50;
export const RUNS_MAX_LIMIT = 200;
const DETAIL_RUNS = 20;

const one = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), item);

export const AutomationRunFiltersSchema = z.object({
  automationId: one(z.string().min(1).optional()),
  status: one(z.enum(AUTOMATION_RUN_STATUSES).optional()),
  jobId: one(z.string().min(1).optional()),
  cursor: one(z.string().min(1).optional()),
  limit: one(z.coerce.number().int().min(1).max(RUNS_MAX_LIMIT).optional()),
});

const emptyCounts = (): AutomationRunCounts => ({ total: 0, pending: 0, matched: 0, skipped: 0, succeeded: 0, failed: 0 });

function runStats(db: DbLike, ctx: AuthContext, automationId?: string): Map<string, { counts: AutomationRunCounts; lastRunAt: string | null }> {
  const rows = db
    .select({
      automationId: automationRuns.automationId,
      status: automationRuns.status,
      n: sql<number>`count(*)`.mapWith(Number),
      last: sql<string | null>`max(${automationRuns.createdAt})`,
    })
    .from(automationRuns)
    .where(and(eq(automationRuns.organisationId, ctx.organisationId), automationId ? eq(automationRuns.automationId, automationId) : undefined))
    .groupBy(automationRuns.automationId, automationRuns.status)
    .all();
  const out = new Map<string, { counts: AutomationRunCounts; lastRunAt: string | null }>();
  for (const r of rows) {
    const cur = out.get(r.automationId) ?? { counts: emptyCounts(), lastRunAt: null };
    cur.counts[r.status] += r.n;
    cur.counts.total += r.n;
    if (r.last && (cur.lastRunAt === null || r.last > cur.lastRunAt)) cur.lastRunAt = r.last;
    out.set(r.automationId, cur);
  }
  return out;
}

function toItem(a: Automation, stats: { counts: AutomationRunCounts; lastRunAt: string | null } | undefined, createdBy: AutomationListItem["createdBy"]): AutomationListItem {
  const trigger = parseJsonColumn(AutomationTriggerSchema, a.trigger, a.trigger);
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    isEnabled: a.isEnabled,
    triggerType: a.triggerType,
    trigger,
    conditions: parseJsonColumn(AutomationConditionsSchema, a.conditions, []),
    actions: parseJsonColumn(AutomationActionsSchema, a.actions, []),
    sortOrder: a.sortOrder,
    archivedAt: a.archivedAt,
    version: a.version,
    createdBy,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    runCounts: stats?.counts ?? emptyCounts(),
    lastRunAt: stats?.lastRunAt ?? null,
  };
}

/** `GET /api/automations?includeArchived` (automation.manage). */
export function listAutomations(db: DbLike, ctx: AuthContext, opts: { includeArchived?: boolean } = {}): AutomationListItem[] {
  assertCan(ctx, "automation.manage");
  const rows = db
    .select()
    .from(automations)
    .where(and(eq(automations.organisationId, ctx.organisationId), opts.includeArchived ? undefined : isNull(automations.archivedAt)))
    .orderBy(asc(automations.sortOrder), asc(automations.name))
    .all();
  const stats = runStats(db, ctx);
  const creators = loadUserRefs(
    db,
    ctx,
    rows.map((r) => r.createdByUserId),
  );
  return rows.map((a) => toItem(a, stats.get(a.id), creators.get(a.createdByUserId) ?? null));
}

/** `GET /api/automations/:id` with the latest runs (automation.manage). Foreign ids → 404. */
export function getAutomationDetail(db: DbLike, ctx: AuthContext, automationId: string): AutomationDetail {
  assertCan(ctx, "automation.manage");
  const a = loadAutomationInOrg(db, ctx, automationId);
  const creator = loadUserRefs(db, ctx, [a.createdByUserId]).get(a.createdByUserId) ?? null;
  const item = toItem(a, runStats(db, ctx, a.id).get(a.id), creator);
  const recentRuns = can(ctx, "automation.view_runs") ? listAutomationRuns(db, ctx, { automationId: a.id, limit: DETAIL_RUNS }).items : [];
  return { ...item, recentRuns };
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") return { createdAt: v[0], id: v[1] };
  } catch {
    // invalid cursor → first page
  }
  return null;
}

/**
 * `GET /api/automation-runs?automationId&status&jobId&cursor&limit` and
 * `GET /api/automations/:id/runs` (automation.view_runs). Newest first,
 * keyset cursor over (created_at, id).
 */
export function listAutomationRuns(db: DbLike, ctx: AuthContext, input: unknown = {}): Paginated<AutomationRunView> {
  assertCan(ctx, "automation.view_runs");
  const f = parseInput(AutomationRunFiltersSchema, input ?? {});
  const limit = f.limit ?? RUNS_DEFAULT_LIMIT;
  const parts: (SQL | undefined)[] = [eq(automationRuns.organisationId, ctx.organisationId)];
  if (f.automationId) parts.push(eq(automationRuns.automationId, f.automationId));
  if (f.status) parts.push(eq(automationRuns.status, f.status));
  if (f.jobId) parts.push(eq(automationRuns.jobId, f.jobId));
  const cursor = decodeCursor(f.cursor);
  if (cursor) {
    parts.push(or(lt(automationRuns.createdAt, cursor.createdAt), and(eq(automationRuns.createdAt, cursor.createdAt), lt(automationRuns.id, cursor.id))));
  }
  const rows = db
    .select({
      run: automationRuns,
      automation: { id: automations.id, name: automations.name },
      job: { id: jobs.id, jobNumber: jobs.jobNumber, name: jobs.name },
      triggerEventType: activityEvents.eventType,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .leftJoin(jobs, eq(jobs.id, automationRuns.jobId))
    .leftJoin(activityEvents, eq(activityEvents.id, automationRuns.triggerEventId))
    .where(and(...parts))
    .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(({ run, automation, job, triggerEventType }) => ({
      id: run.id,
      automation,
      job: job ? { id: job.id, jobNumber: job.jobNumber, name: job.name } : null,
      triggerEventId: run.triggerEventId,
      triggerEventType: triggerEventType ?? null,
      depth: run.depth,
      status: run.status,
      conditionsSnapshot: parseJsonColumn(AutomationConditionsSchema, run.conditionsSnapshot, []),
      actionsPerformed: parseJsonColumn(AutomationActionResultsSchema, run.actionsPerformed, []),
      error: run.error,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.run.createdAt, last.run.id) : null,
  };
}
