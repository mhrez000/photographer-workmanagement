/**
 * Turns /activity URL params into `listActivity` / `GET /api/activity`
 * input. Pure (no server imports): shared by the page and its CSV export.
 *
 *   userId · events (group keys, comma list) · job (job number) or jobId ·
 *   range (RANGE_PRESETS; absent = any date) + from/to for "custom".
 */
import { RANGE_PRESETS } from "@/lib/constants";
import { resolveRange, type RangePreset } from "@/lib/dates";
import { eventTypesForGroups } from "./event-groups";

type SP = Record<string, string | string[] | undefined>;

function first(sp: SP, key: string): string | undefined {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

function list(sp: SP, key: string): string[] {
  const v = sp[key];
  const raw = v === undefined ? [] : Array.isArray(v) ? v : [v];
  return raw.flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
}

export interface ActivityPageFilters {
  userId?: string;
  jobId?: string;
  /** Job number typed by the user (resolved to `jobId` by the page). */
  jobNumber?: string;
  groups: string[];
  range?: RangePreset;
  rangeLabel?: string;
  /** Query for listActivity / /api/activity (without jobId when only a number was given). */
  query: Record<string, string | string[] | undefined>;
  active: boolean;
}

export function parseActivityPageFilters(sp: SP, timeZone: string, allowedGroups: readonly string[]): ActivityPageFilters {
  const userId = first(sp, "userId");
  const jobId = first(sp, "jobId");
  const jobNumber = first(sp, "job")?.toUpperCase();
  const groups = list(sp, "events").filter((g) => allowedGroups.includes(g));
  const rawRange = first(sp, "range");
  const range = rawRange && (RANGE_PRESETS as readonly string[]).includes(rawRange) ? (rawRange as RangePreset) : undefined;

  const query: Record<string, string | string[] | undefined> = { userId, jobId };
  if (groups.length) query.eventType = eventTypesForGroups(groups);
  let rangeLabel: string | undefined;
  if (range) {
    const resolved = resolveRange(range, timeZone, { from: first(sp, "from"), to: first(sp, "to") });
    query.from = resolved.from;
    query.to = resolved.to;
    rangeLabel = resolved.label;
  }
  return {
    userId,
    jobId,
    jobNumber,
    groups,
    range,
    rangeLabel,
    query,
    active: Boolean(userId || jobId || jobNumber || groups.length || range),
  };
}

/** Removes undefined keys (for building hrefs / API queries). */
export function compactQuery(q: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(q)) if (v !== undefined && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  return out;
}
