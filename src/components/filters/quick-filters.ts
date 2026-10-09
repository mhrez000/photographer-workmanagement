import type { QuickFilter } from "@/lib/constants";
import { DEFAULT_TIMEZONE, formatDate, formatDateTime, toDate } from "@/lib/dates";

/** Display labels for QUICK_FILTERS (spec §20). */
export const QUICK_FILTER_LABELS: Record<QuickFilter, string> = {
  my_jobs: "My jobs",
  unassigned: "Unassigned",
  overdue: "Overdue",
  due_today: "Due today",
  due_this_week: "Due this week",
  awaiting_review: "Awaiting review",
  revision_required: "Revision required",
  completed: "Completed",
  cancelled: "Cancelled",
  paused: "Paused",
};

/** Chip tone per quick filter (danger for overdue, attention for today…). */
export const QUICK_FILTER_TONES: Partial<Record<QuickFilter, "danger" | "attention" | "warning">> = {
  overdue: "danger",
  due_today: "attention",
  revision_required: "warning",
};

/**
 * Drill-down params set by dashboard KPIs and bottleneck alerts (no facet
 * control of their own). The FilterBar shows each as a removable chip and
 * "Clear all" removes them, so a drilled-down list never looks unfiltered.
 */
export const JOB_SCOPE_KEYS = [
  "completedFrom",
  "completedTo",
  "revisedFrom",
  "revisedTo",
  "statusEnteredBefore",
  "isPaused",
  "includeCancelled",
] as const;

/** URL keys owned by the job FilterBar (cleared by "Clear all"). */
export const JOB_FILTER_KEYS = [
  "q",
  "quick",
  "statusCategory",
  "statusId",
  "editorId",
  "photographerId",
  "clientId",
  "projectId",
  "jobTypeId",
  "priority",
  "dueFrom",
  "dueTo",
  ...JOB_SCOPE_KEYS,
] as const;

/** A removable chip for one drill-down (JOB_SCOPE_KEYS) in the URL. */
export interface ScopeChip {
  id: string;
  label: string;
  /** URL keys removed together when the chip is dismissed. */
  keys: readonly string[];
}

const CIVIL = /^\d{4}-\d{2}-\d{2}$/;
const TRUE_VALUES = ["1", "true", "yes"];

/** A bound as a date label; an exclusive instant upper bound shows the day before it ends. */
function boundLabel(value: string, timeZone: string, edge: "from" | "to"): string {
  if (CIVIL.test(value)) return formatDate(value, timeZone);
  const d = toDate(value);
  if (!d) return value.slice(0, 40);
  return formatDate(edge === "to" ? new Date(d.getTime() - 1) : d, timeZone);
}

function rangeLabel(noun: string, from: string | null, to: string | null, timeZone: string): string {
  const f = from ? boundLabel(from, timeZone, "from") : null;
  const t = to ? boundLabel(to, timeZone, "to") : null;
  if (f && t) return f === t ? `${noun} on ${f}` : `${noun} ${f} – ${t}`;
  return f ? `${noun} since ${f}` : `${noun} until ${t}`;
}

/**
 * Chips for the drill-down params present in the URL (`get` = first value of
 * a key). Dashboard KPIs and bottleneck alerts link with these; without a
 * chip the list would look like plain All Work while silently filtered.
 */
export function scopeChips(get: (key: string) => string | null | undefined, timeZone: string = DEFAULT_TIMEZONE): ScopeChip[] {
  const chips: ScopeChip[] = [];
  const v = (k: string) => {
    const raw = get(k);
    return raw === null || raw === undefined || raw === "" ? null : raw;
  };
  const completedFrom = v("completedFrom");
  const completedTo = v("completedTo");
  if (completedFrom || completedTo) {
    chips.push({ id: "completed", label: rangeLabel("Completed", completedFrom, completedTo, timeZone), keys: ["completedFrom", "completedTo"] });
  }
  const revisedFrom = v("revisedFrom");
  const revisedTo = v("revisedTo");
  if (revisedFrom || revisedTo) {
    chips.push({ id: "revised", label: rangeLabel("Revision requested", revisedFrom, revisedTo, timeZone), keys: ["revisedFrom", "revisedTo"] });
  }
  const entered = v("statusEnteredBefore");
  if (entered) {
    const d = CIVIL.test(entered) ? formatDate(entered, timeZone) : toDate(entered) ? formatDateTime(entered, timeZone) : entered.slice(0, 40);
    chips.push({ id: "statusEnteredBefore", label: `In this status since before ${d}`, keys: ["statusEnteredBefore"] });
  }
  const paused = v("isPaused");
  if (paused) {
    chips.push({ id: "isPaused", label: TRUE_VALUES.includes(paused.toLowerCase()) ? "Paused only" : "Not paused", keys: ["isPaused"] });
  }
  const cancelled = v("includeCancelled");
  if (cancelled && TRUE_VALUES.includes(cancelled.toLowerCase())) {
    chips.push({ id: "includeCancelled", label: "Including cancelled", keys: ["includeCancelled"] });
  }
  return chips;
}
