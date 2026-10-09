import { RANGE_PRESETS } from "@/lib/constants";
import type { RangePreset } from "@/lib/dates";

type SearchParams = Record<string, string | string[] | undefined>;

const CIVIL = /^\d{4}-\d{2}-\d{2}$/;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Turns `?range=&from=&to=` into input the range queries accept, never
 * throwing on a hand-edited URL: unknown presets fall back to the default,
 * malformed dates are dropped, reversed custom bounds are swapped, and a
 * custom range with no dates falls back to the default preset.
 */
export function rangeFromParams(sp: SearchParams, fallback: Exclude<RangePreset, "custom">): { range: RangePreset; from?: string; to?: string } {
  const raw = first(sp.range);
  let range: RangePreset = raw && (RANGE_PRESETS as readonly string[]).includes(raw) ? (raw as RangePreset) : fallback;
  let from = first(sp.from);
  let to = first(sp.to);
  from = from && CIVIL.test(from) && Number.isFinite(Date.parse(from)) ? from : undefined;
  to = to && CIVIL.test(to) && Number.isFinite(Date.parse(to)) ? to : undefined;
  if (range !== "custom") return { range };
  if (!from && !to) {
    range = fallback;
    return { range };
  }
  if (from && to && from > to) [from, to] = [to, from];
  return { range, ...(from ? { from } : {}), ...(to ? { to } : {}) };
}
