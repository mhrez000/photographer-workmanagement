/**
 * URL state of the Jobs page (docs/SIMPLIFICATION-PLAN.md §8 "Kept, and polished"):
 *
 *   ?stage=needs_editor|with_editor|ready_to_check|changes_asked|done   (none = All active)
 *   ?late=1            only late jobs
 *   ?cancelled=1       show cancelled jobs too ("Show cancelled")
 *   ?q= ?editorId= ?clientId=
 *   ?view=calendar     the List / Calendar switch (+ ?month=YYYY-MM)
 *   ?cursor=           paging
 *
 * Server-safe: used by the page (to parse) and by links (to build hrefs).
 */
import { STAGE_TABS, type Stage } from "@/lib/stages";
import type { StageFilter } from "@/lib/types";

export const JOBS_PATH = "/jobs";

export type JobsView = "list" | "calendar";

export interface JobsUrlState {
  stage: StageFilter;
  late: boolean;
  showCancelled: boolean;
  q: string;
  editorId: string;
  clientId: string;
  view: JobsView;
  month: string | undefined;
  cursor: string | undefined;
}

export type SearchParams = Record<string, string | string[] | undefined>;

function one(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === "" ? undefined : s;
}

function isOn(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

export function isStageTab(value: string | undefined): value is Stage {
  return value !== undefined && (STAGE_TABS as readonly string[]).includes(value);
}

export function parseJobsUrl(sp: SearchParams): JobsUrlState {
  const rawStage = one(sp, "stage");
  const stage: StageFilter = isStageTab(rawStage) ? rawStage : rawStage === "cancelled" ? "cancelled" : "all_active";
  return {
    stage,
    late: isOn(one(sp, "late")),
    showCancelled: isOn(one(sp, "cancelled")),
    q: (one(sp, "q") ?? "").trim().slice(0, 200),
    editorId: one(sp, "editorId") ?? "",
    clientId: one(sp, "clientId") ?? "",
    view: one(sp, "view") === "calendar" ? "calendar" : "list",
    month: one(sp, "month"),
    cursor: one(sp, "cursor"),
  };
}

/** Href for the Jobs page with `patch` applied to `state` (null / "" / false removes a key; cursor is dropped). */
export function jobsHref(state: Partial<JobsUrlState>, patch: Partial<JobsUrlState> = {}, path = JOBS_PATH): string {
  const s = { ...state, ...patch };
  const p = new URLSearchParams();
  if (s.stage && s.stage !== "all_active") p.set("stage", s.stage);
  if (s.late) p.set("late", "1");
  if (s.showCancelled) p.set("cancelled", "1");
  if (s.q) p.set("q", s.q);
  if (s.editorId) p.set("editorId", s.editorId);
  if (s.clientId) p.set("clientId", s.clientId);
  if (s.view === "calendar") p.set("view", "calendar");
  if (s.view === "calendar" && s.month) p.set("month", s.month);
  if ("cursor" in patch && patch.cursor) p.set("cursor", patch.cursor);
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
}

/** True when any search / editor / client / late / cancelled filter is applied. */
export function hasFilters(state: JobsUrlState): boolean {
  return Boolean(state.q || state.editorId || state.clientId || state.late || state.showCancelled);
}
