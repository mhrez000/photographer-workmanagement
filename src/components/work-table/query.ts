/**
 * Search params → `listJobs` input (pure; used by the server pages and by the
 * client "Load more" request against GET /api/jobs).
 */
import { parseSort, sortParam } from "./columns";

export type SearchParamsRecord = Record<string, string | string[] | undefined>;

/** View-only params that never reach the query layer. */
const UI_ONLY_KEYS = new Set(["columns", "dir", "cursor", "tab"]);

/**
 * Normalised filter input for `listJobs` / `getTeamWork`: drops UI-only keys,
 * folds `?dir=` into `?sort=col:dir`, keeps every other key as given (the Zod
 * schema validates and strips unknown keys).
 */
export function toJobListInput(sp: SearchParamsRecord, overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(sp)) {
    if (UI_ONLY_KEYS.has(key) || raw === undefined) continue;
    const value = Array.isArray(raw) ? raw.filter(Boolean).join(",") : raw;
    if (value !== "") out[key] = value;
  }
  const dir = typeof sp.dir === "string" ? sp.dir : Array.isArray(sp.dir) ? sp.dir[0] : undefined;
  if (out.sort) {
    const parsed = parseSort(out.sort, dir);
    const normalised = sortParam(parsed);
    if (normalised) out.sort = normalised;
    else delete out.sort;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === "") delete out[key];
    else out[key] = value;
  }
  return out;
}

/** First applied sort key (from `listJobs(...).applied.sort`) as a header indicator. */
export function appliedSortOf(sort: readonly { column: string; dir: "asc" | "desc" }[] | undefined | null): { column: import("@/lib/constants").JobTableColumn; dir: "asc" | "desc" } | null {
  const first = sort?.[0];
  if (!first) return null;
  return parseSort(`${first.column}:${first.dir}`);
}

/** Stable query string for an input record (sorted keys). */
export function toQueryString(input: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(input).sort()) params.set(key, input[key]);
  return params.toString();
}
