/**
 * Pure helpers shared by the job detail page (server-safe: no React, no
 * browser APIs). Durations arrive in seconds from the queries.
 */
import { formatDuration } from "@/lib/dates";
import type { EventType, StatusCategory } from "@/lib/constants";
import type { UserRef } from "@/lib/types";
import { humanise } from "@/lib/utils";

/** "2d 4h", "35m" — for a duration in seconds (null → "—"). */
export function formatSeconds(seconds: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  return formatDuration(Math.max(0, seconds) * 1000, opts);
}

/** Display name for an actor; null actors are the system / automations. */
export function actorName(user: Pick<UserRef, "name"> | null | undefined, fallback = "System"): string {
  return user?.name ?? fallback;
}

/** Job detail tabs in display order (keys match `JobDetailTab`). */
export const JOB_TABS = ["overview", "links", "notes", "comments", "revisions", "timeline", "activity", "history", "time"] as const;
export type JobTab = (typeof JOB_TABS)[number];

export function isJobTab(value: string | undefined): value is JobTab {
  return value !== undefined && (JOB_TABS as readonly string[]).includes(value);
}

export const JOB_TAB_LABELS: Record<JobTab, string> = {
  overview: "Overview",
  links: "Links",
  notes: "Notes",
  comments: "Comments",
  revisions: "Revisions",
  timeline: "Timeline",
  activity: "Activity",
  history: "History",
  time: "Time",
};

/**
 * Production stages for the Timeline tab and the overview stepper
 * (spec §11: Assignment → Editing → Review → Revision → Approval → Delivery).
 */
export const STAGES = ["assignment", "editing", "review", "revision", "approval", "delivery"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  assignment: "Assignment",
  editing: "Editing",
  review: "Review",
  revision: "Revision",
  approval: "Approval",
  delivery: "Delivery",
};

/** Which production stage a status category belongs to (null = not a stage: new/cancelled). */
export function stageOf(category: StatusCategory): Stage | null {
  switch (category) {
    case "ready":
    case "assigned":
    case "accepted":
      return "assignment";
    case "in_progress":
      return "editing";
    case "submitted":
    case "review":
    case "resubmitted":
      return "review";
    case "revision":
      return "revision";
    case "approved":
      return "approval";
    case "delivered":
    case "completed":
      return "delivery";
    default:
      return null;
  }
}

/** Activity tab filter groups (`?events=status,people`). */
export const ACTIVITY_GROUPS = {
  status: { label: "Status", types: [
    "job.status_changed", "job.accepted", "job.declined", "job.work_started", "job.submitted", "job.review_started",
    "job.approved", "job.delivered", "job.completed", "job.cancelled", "job.reopened", "job.restored",
    "job.workflow_migrated", "job.stage_reattributed", "job.paused", "job.resumed",
  ] },
  people: { label: "People", types: ["assignment.created", "assignment.ended"] },
  details: { label: "Details & dates", types: [
    "job.created", "job.field_changed", "job.priority_changed", "job.due_date_changed", "job.review_due_date_changed",
    "job.delivery_due_date_changed", "job.shoot_date_changed", "job.became_overdue", "job.review_overdue",
  ] },
  revisions: { label: "Revisions", types: ["revision.requested", "revision.resolved", "revision.withdrawn", "revision.updated"] },
  comments: { label: "Comments", types: ["comment.added", "comment.edited", "comment.deleted", "comment.mentioned"] },
  notes: { label: "Notes", types: ["note.added", "note.edited", "note.archived", "note.restored"] },
  links: { label: "Links", types: ["link.added", "link.replaced", "link.removed"] },
  time: { label: "Time", types: ["work_session.started", "work_session.ended"] },
} satisfies Record<string, { label: string; types: readonly EventType[] }>;

export type ActivityGroup = keyof typeof ACTIVITY_GROUPS;
export const ACTIVITY_GROUP_KEYS = Object.keys(ACTIVITY_GROUPS) as ActivityGroup[];

export function isActivityGroup(value: string): value is ActivityGroup {
  return Object.prototype.hasOwnProperty.call(ACTIVITY_GROUPS, value);
}

/** The group an event type belongs to (null = ungrouped, e.g. automation runs). */
export function activityGroupOf(type: string): ActivityGroup | null {
  for (const key of ACTIVITY_GROUP_KEYS) {
    if ((ACTIVITY_GROUPS[key].types as readonly string[]).includes(type)) return key;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Before → after values for audit events                             */
/* ------------------------------------------------------------------ */

export interface ValueChange {
  key: string;
  label: string;
  before: string | null;
  after: string | null;
}

/** Raw ids are noise next to their readable siblings (statusName, label, …). */
const isIdKey = (key: string) => key === "id" || /Ids?$/.test(key);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Readable scalar for a JSON value (dates through `formatDate` by the caller). */
export function scalarText(value: unknown, formatInstant: (iso: string) => string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length === 0) return "";
    return ISO_INSTANT.test(value) ? formatInstant(value) : value;
  }
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map((v) => scalarText(v, formatInstant) ?? "—").join(", ");
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const k of ["detail", "name", "label", "statusName", "message"]) if (typeof o[k] === "string") return o[k] as string;
    return JSON.stringify(value);
  }
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Field-level differences between an event's previous and new values.
 * `{field, value}` pairs (job.field_changed) collapse to one row named after
 * the field; id-only keys are hidden when a readable sibling exists.
 */
export function valueChanges(previous: unknown, next: unknown, formatInstant: (iso: string) => string): ValueChange[] {
  const prev = asRecord(previous);
  const nxt = asRecord(next);

  if ((prev && "field" in prev && "value" in prev) || (nxt && "field" in nxt && "value" in nxt)) {
    const field = String((prev?.field ?? nxt?.field) as string);
    return [{ key: field, label: humanise(field), before: scalarText(prev?.value, formatInstant), after: scalarText(nxt?.value, formatInstant) }];
  }

  if (!prev && !nxt) {
    if (previous === next) return [];
    return [{ key: "value", label: "Value", before: scalarText(previous, formatInstant), after: scalarText(next, formatInstant) }];
  }

  const keys = [...new Set([...Object.keys(prev ?? {}), ...Object.keys(nxt ?? {})])];
  const visible = keys.filter((k) => !isIdKey(k) || keys.length === 1);
  const out: ValueChange[] = [];
  for (const key of visible) {
    const before = scalarText(prev?.[key], formatInstant);
    const after = scalarText(nxt?.[key], formatInstant);
    if (prev && nxt && before === after) continue;
    out.push({ key, label: key === "value" ? "Value" : humanise(key), before, after });
  }
  return out;
}

/** Keeps the first `max` characters of long text values for inline display. */
export function clip(text: string | null, max = 160): string | null {
  if (text === null) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
