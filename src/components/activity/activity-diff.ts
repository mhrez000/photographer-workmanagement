/**
 * Before → after rows for an activity event (spec §6: Who, What, When,
 * Before, After). Pure: turns the frozen previousValue / newValue snapshots
 * into labelled, display-ready values. Ids are resolved through the
 * `people` map or dropped; noisy plumbing keys are hidden.
 */
import { PRIORITY_META, STATUS_CATEGORY_META, type Priority, type StatusCategory } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/dates";
import type { ActivityFeedItem } from "@/lib/types";

export type DiffValue =
  | { kind: "text"; text: string }
  | { kind: "long"; text: string }
  | { kind: "status"; name: string; category: StatusCategory }
  | { kind: "person"; name: string }
  | { kind: "url"; url: string; label: string };

export interface DiffRow {
  key: string;
  label: string;
  before: DiffValue | null;
  after: DiffValue | null;
}

type Obj = Record<string, unknown>;

const HIDDEN_KEYS = new Set([
  "statusId", "linkId", "sessionId", "transitionId", "workflowId", "revisionId", "parentCommentId", "rootCommentId",
  "mentionUserIds", "order", "config", "layout", "actionsPerformed", "previousTransitionId", "supersedesLinkId",
  "clientId", "projectId", "jobTypeId", "teamId", "memberIds", "fromStatusId", "toStatusId", "sourceWorkflowId",
  "assignmentId", "userName", "editorName", "mentionedUserName", "statusName", "workflowName", "isPinned", "statusKeys",
  "trigger", "conditions", "actions", "provider", "from",
]);

const LABELS: Record<string, string> = {
  value: "Value",
  priority: "Priority",
  category: "Status",
  isPaused: "Paused",
  dueDate: "Due date",
  reviewDueDate: "Review due",
  deliveryDueDate: "Delivery due",
  shootDate: "Shoot date",
  overdueSince: "Overdue since",
  body: "Text",
  kind: "Kind",
  url: "URL",
  label: "Label",
  name: "Name",
  description: "Description",
  instructions: "Instructions",
  reason: "Reason",
  resolution: "Resolution",
  resolutionNote: "Resolution note",
  resolvedAt: "Resolved",
  resolvedByUserId: "Resolved by",
  revisionNumber: "Revision",
  assigneeUserId: "Assignee",
  userId: "Person",
  editorId: "Editor",
  photographerId: "Photographer",
  leadUserId: "Lead",
  mentionedUserId: "Mentioned",
  role: "Role",
  archivedAt: "Archived",
  completedAt: "Completed",
  cancelledAt: "Cancelled",
  startedAt: "Started",
  endedAt: "Ended",
  durationSeconds: "Duration",
  endReason: "Ended because",
  contactName: "Contact",
  email: "Email",
  phone: "Phone",
  address: "Address",
  startDate: "Start",
  endDate: "End",
  notes: "Notes",
  colour: "Colour",
  estimatedHours: "Estimated hours",
  completionPercent: "Completion",
  isActive: "Active",
  band: "Workload",
  capacityHoursPerWeek: "Capacity (h/week)",
  jobNumber: "Job number",
  title: "Title",
  status: "Result",
  score: "Score",
  ratio: "Load ratio",
  active: "Active jobs",
  isEnabled: "Enabled",
  isShared: "Shared",
  isDefault: "Default",
  sortOrder: "Position",
  key: "Key",
  defaultEstimatedHours: "Default hours",
};

const DATE_EVENT_LABELS: Record<string, string> = {
  "job.due_date_changed": "Due date",
  "job.review_due_date_changed": "Review due",
  "job.delivery_due_date_changed": "Delivery due",
  "job.shoot_date_changed": "Shoot date",
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const CIVIL = /^\d{4}-\d{2}-\d{2}$/;
const PERSON_KEYS = new Set(["userId", "editorId", "photographerId", "assigneeUserId", "resolvedByUserId", "leadUserId", "mentionedUserId"]);
const LONG_KEYS = new Set(["body", "description", "instructions", "notes", "resolutionNote"]);

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function humanise(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export interface DiffFormatContext {
  timeZone: string;
  /** user id → display name (ids missing from the map fall back to names frozen in the snapshot). */
  people: Readonly<Record<string, string>>;
}

/** End-of-day deadlines read better as a date than a time. */
function isEndOfDay(iso: string, timeZone: string): boolean {
  return /11:59\s?pm/i.test(formatDateTime(iso, timeZone));
}

function sentenceCase(raw: string): string {
  const spaced = raw.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatValue(key: string, raw: unknown, f: DiffFormatContext, sibling?: Obj): DiffValue | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (PERSON_KEYS.has(key) && typeof raw === "string") {
    const frozen =
      sibling && typeof sibling.userName === "string"
        ? sibling.userName
        : sibling && typeof sibling.editorName === "string"
          ? sibling.editorName
          : sibling && typeof sibling.mentionedUserName === "string"
            ? sibling.mentionedUserName
            : null;
    return { kind: "person", name: f.people[raw] ?? frozen ?? "Former team member" };
  }
  if (key === "category" && typeof raw === "string" && raw in STATUS_CATEGORY_META) {
    const category = raw as StatusCategory;
    const name = sibling && typeof sibling.statusName === "string" ? sibling.statusName : STATUS_CATEGORY_META[category].label;
    return { kind: "status", name, category };
  }
  if (key === "priority" && typeof raw === "string" && raw in PRIORITY_META) return { kind: "text", text: PRIORITY_META[raw as Priority].label };
  if (key === "url" && typeof raw === "string") {
    const label = sibling && typeof sibling.label === "string" && sibling.label ? sibling.label : raw;
    return { kind: "url", url: raw, label };
  }
  if (key === "durationSeconds" && typeof raw === "number") {
    const m = Math.round(raw / 60);
    return { kind: "text", text: m < 1 ? "Under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min` };
  }
  if (key === "completionPercent" && typeof raw === "number") return { kind: "text", text: `${raw}%` };
  if (typeof raw === "boolean") return { kind: "text", text: raw ? "Yes" : "No" };
  if (typeof raw === "number") return { kind: "text", text: String(raw) };
  if (typeof raw === "string") {
    if (ISO.test(raw)) return { kind: "text", text: isEndOfDay(raw, f.timeZone) ? formatDate(raw, f.timeZone) : formatDateTime(raw, f.timeZone) };
    if (CIVIL.test(raw)) return { kind: "text", text: formatDate(raw, f.timeZone) };
    if (key === "band" || key === "role" || key === "endReason" || key === "kind" || key === "resolution" || key === "status") {
      return { kind: "text", text: sentenceCase(raw) };
    }
    if (LONG_KEYS.has(key) || raw.length > 80) return { kind: "long", text: raw.length > 600 ? `${raw.slice(0, 600)}…` : raw };
    return { kind: "text", text: raw };
  }
  if (Array.isArray(raw)) {
    const parts = raw.filter((x) => typeof x === "string" || typeof x === "number").map(String);
    return parts.length ? { kind: "text", text: parts.join(", ") } : null;
  }
  return null;
}

function sameValue(a: DiffValue | null, b: DiffValue | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Labelled before → after rows (empty when there is nothing useful to show). */
export function buildDiff(item: Pick<ActivityFeedItem, "eventType" | "previousValue" | "newValue">, f: DiffFormatContext): DiffRow[] {
  const prev = isObj(item.previousValue) ? item.previousValue : null;
  const next = isObj(item.newValue) ? item.newValue : null;
  if (!prev && !next) return [];

  // `{ field, value }` snapshots (job.field_changed, settings.updated).
  if ((prev && "field" in prev) || (next && "field" in next)) {
    const field = String((next ?? prev)?.field ?? "value");
    if (/Id$/.test(field) && !PERSON_KEYS.has(field)) return [];
    const before = formatValue(field, prev?.value, f);
    const after = formatValue(field, next?.value, f);
    return sameValue(before, after) ? [] : [{ key: field, label: humanise(field), before, after }];
  }

  // `{ value }` deadline changes.
  const dateLabel = DATE_EVENT_LABELS[item.eventType];
  if (dateLabel) {
    const before = formatValue("value", prev?.value, f);
    const after = formatValue("value", next?.value, f);
    return [
      {
        key: "value",
        label: dateLabel,
        before: before ?? { kind: "text", text: "No date" },
        after: after ?? { kind: "text", text: "Cleared" },
      },
    ];
  }

  const keys: string[] = [];
  for (const k of [...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]) if (!keys.includes(k) && !HIDDEN_KEYS.has(k)) keys.push(k);

  const rows: DiffRow[] = [];
  for (const key of keys) {
    const before = formatValue(key, prev?.[key], f, prev ?? undefined);
    const after = formatValue(key, next?.[key], f, next ?? undefined);
    if (!before && !after) continue;
    if (prev && next && sameValue(before, after)) continue;
    rows.push({ key, label: humanise(key), before, after });
    if (rows.length >= 8) break;
  }
  // A status pair is the headline: keep it first.
  rows.sort((a, b) => (a.key === "category" ? -1 : b.key === "category" ? 1 : 0));
  return rows;
}
