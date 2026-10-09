/**
 * Frozen, actor-less audit summaries (ARCHITECTURE.md §5).
 *
 * `summarise()` is called exactly once per event, by `recordEvent()`, and the
 * result is stored in `activity_events.summary`. It never contains the actor:
 * the UI renders `<actor name> <summary>` at read time, so anonymising a user
 * rewrites every line they appear in. Summaries start with a lowercase verb
 * in the past tense ("changed status from Assigned to In Progress").
 *
 * `describeEventForFeed()` builds the global-feed sentence
 * (`John completed “123 Smith Street”`).
 *
 * Pure module: no DB, no React.
 */
import {
  LINK_KIND_META,
  NOTE_KIND_META,
  NOTIFICATION_TYPE_META,
  PRIORITY_META,
  ROLE_LABELS,
  STATUS_CATEGORY_META,
  WORKLOAD_BAND_META,
  type EventType,
  type LinkKind,
  type NoteKind,
  type NotificationType,
  type Priority,
  type Role,
  type StatusCategory,
  type WorkloadBand,
} from "./constants";
import { DEFAULT_TIMEZONE, formatDate, formatDuration } from "./dates";
import { humanise } from "./utils";

/* ------------------------------------------------------------------ */
/*  Value accessors (event payloads are untyped JSON)                  */
/* ------------------------------------------------------------------ */

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Bag) : {};
}

function str(value: unknown, key: string): string | null {
  const v = bag(value)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(value: unknown, key: string): number | null {
  const v = bag(value)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(value: unknown, key: string): boolean {
  return bag(value)[key] === true;
}

/** First string found under `key` in the given payloads. */
function firstStr(key: string, ...values: unknown[]): string | null {
  for (const v of values) {
    const s = str(v, key);
    if (s) return s;
  }
  return null;
}

const quote = (s: string) => `“${s}”`;

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

function priorityLabel(value: unknown): string | null {
  return typeof value === "string" && value in PRIORITY_META ? PRIORITY_META[value as Priority].label : null;
}

function roleLabel(value: unknown): string | null {
  return typeof value === "string" && value in ROLE_LABELS ? ROLE_LABELS[value as Role] : null;
}

function noteKindLabel(value: unknown): string {
  if (typeof value === "string" && value in NOTE_KIND_META) {
    return NOTE_KIND_META[value as NoteKind].label.replace(/s$/, "").toLowerCase();
  }
  return "note";
}

function linkKindLabel(value: unknown): string {
  if (typeof value === "string" && value in LINK_KIND_META) return LINK_KIND_META[value as LinkKind].label.toLowerCase();
  return "external";
}

function statusLabel(value: unknown): string | null {
  const name = str(value, "statusName");
  if (name) return name;
  const cat = str(value, "category");
  return cat && cat in STATUS_CATEGORY_META ? STATUS_CATEGORY_META[cat as StatusCategory].label : null;
}

function bandLabel(value: unknown): string | null {
  const b = str(value, "band");
  return b && b in WORKLOAD_BAND_META ? WORKLOAD_BAND_META[b as WorkloadBand].label : null;
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  return "a new value";
}

export interface SummaryOptions {
  /** Organisation timezone for dates inside the sentence. */
  timeZone?: string;
}

/* ------------------------------------------------------------------ */
/*  Field-level helpers                                                */
/* ------------------------------------------------------------------ */

const JOB_FIELD_LABELS: Record<string, string> = {
  name: "name",
  description: "description",
  clientId: "client",
  projectId: "project",
  jobTypeId: "job type",
  estimatedHours: "estimated hours",
  completionPercent: "completion",
};

function jobFieldSummary(prev: unknown, next: unknown, meta: unknown): string {
  const field = firstStr("field", next, prev) ?? "field";
  const label = JOB_FIELD_LABELS[field] ?? humanise(field).toLowerCase();
  const before = bag(prev).value;
  const after = bag(next).value;
  switch (field) {
    case "name":
      return `renamed the job from ${quote(display(before))} to ${quote(display(after))}`;
    case "description":
      return after ? "updated the description" : "cleared the description";
    case "completionPercent":
      return `changed completion from ${display(before)}% to ${display(after)}%`;
    case "estimatedHours":
      return `changed estimated hours from ${display(before)} to ${display(after)}`;
    case "clientId":
    case "projectId":
    case "jobTypeId": {
      const from = str(meta, "fromLabel");
      const to = str(meta, "toLabel");
      return from && to ? `changed the ${label} from ${quote(from)} to ${quote(to)}` : to ? `changed the ${label} to ${quote(to)}` : `changed the ${label}`;
    }
    default:
      return `changed ${label} from ${display(before)} to ${display(after)}`;
  }
}

function dateChangeSummary(what: string, prev: unknown, next: unknown, meta: unknown, tz: string): string {
  const before = str(prev, "value");
  const after = str(next, "value");
  const fmt = (v: string) => formatDate(v, tz);
  const sla = str(meta, "cause") === "sla_default" ? " (review SLA)" : "";
  if (!after) return `cleared the ${what}`;
  if (!before) return `set the ${what} to ${fmt(after)}${sla}`;
  return `changed the ${what} from ${fmt(before)} to ${fmt(after)}${sla}`;
}

function targetName(prev: unknown, next: unknown, meta: unknown): string {
  return firstStr("name", next, prev) ?? firstStr("targetName", meta) ?? firstStr("userName", meta) ?? "a team member";
}

function entityName(prev: unknown, next: unknown, meta: unknown, fallback: string): string {
  const name = firstStr("name", next, prev, meta);
  return name ? quote(name) : fallback;
}

function changedFields(prev: unknown, next: unknown): string {
  const keys = Object.keys(bag(next)).length > 0 ? Object.keys(bag(next)) : Object.keys(bag(prev));
  const shown = keys.filter((k) => k !== "id" && k !== "version").slice(0, 3).map((k) => humanise(k).toLowerCase());
  return shown.length > 0 ? ` (${shown.join(", ")})` : "";
}

/* ------------------------------------------------------------------ */
/*  summarise                                                          */
/* ------------------------------------------------------------------ */

function assertNever(value: never): never {
  throw new Error(`summarise: unhandled event type ${String(value)}`);
}

/**
 * Actor-less sentence for an event. Every EventType is handled (the
 * `assertNever` default makes a new type a compile error until it is added).
 */
export function summarise(
  eventType: EventType,
  previousValue: unknown,
  newValue: unknown,
  metadata: unknown,
  options: SummaryOptions = {},
): string {
  const prev = previousValue;
  const next = newValue;
  const meta = metadata;
  const tz = options.timeZone ?? DEFAULT_TIMEZONE;

  switch (eventType) {
    /* ---------------- jobs ---------------- */
    case "job.created": {
      const number = str(next, "jobNumber");
      const name = str(next, "name");
      return `created job ${[number, name ? quote(name) : null].filter(Boolean).join(" ")}`.trim();
    }
    case "job.field_changed":
      return jobFieldSummary(prev, next, meta);
    case "job.priority_changed": {
      const from = priorityLabel(bag(prev).priority);
      const to = priorityLabel(bag(next).priority) ?? "a new priority";
      return from ? `changed priority from ${from} to ${to}` : `set priority to ${to}`;
    }
    case "job.due_date_changed":
      return dateChangeSummary("due date", prev, next, meta, tz);
    case "job.review_due_date_changed":
      return dateChangeSummary("review deadline", prev, next, meta, tz);
    case "job.delivery_due_date_changed":
      return dateChangeSummary("delivery date", prev, next, meta, tz);
    case "job.shoot_date_changed":
      return dateChangeSummary("shoot date", prev, next, meta, tz);
    case "job.status_changed": {
      const from = statusLabel(prev);
      const to = statusLabel(next) ?? "a new status";
      const suffix = bool(meta, "isOverride") ? " (override)" : "";
      return from ? `changed status from ${from} to ${to}${suffix}` : `set status to ${to}${suffix}`;
    }
    case "job.accepted":
      return "accepted the job";
    case "job.declined": {
      const reason = str(meta, "reason");
      return reason ? `declined the job: ${reason}` : "declined the job";
    }
    case "job.work_started":
      return "started work";
    case "job.paused":
      return "paused work";
    case "job.resumed":
      return "resumed work";
    case "job.submitted": {
      if (bool(meta, "resubmission")) {
        const n = num(meta, "revisionNumber");
        return n ? `resubmitted work for revision #${n}` : "resubmitted work for review";
      }
      return "submitted work for review";
    }
    case "job.review_started":
      return "started the review";
    case "job.approved": {
      const onTime = bag(meta).onTime;
      return onTime === false ? "approved the work (late)" : "approved the work";
    }
    case "job.delivered":
      return "delivered the job to the client";
    case "job.completed":
      return "completed the job";
    case "job.cancelled": {
      const reason = str(meta, "reason");
      return reason ? `cancelled the job: ${reason}` : "cancelled the job";
    }
    case "job.reopened": {
      const reason = str(meta, "reason");
      return reason ? `reopened the job: ${reason}` : "reopened the job";
    }
    case "job.restored":
      return "restored the cancelled job";
    case "job.became_overdue":
      return "flagged the job as overdue";
    case "job.review_overdue":
      return "flagged the review as overdue";
    case "job.workflow_migrated": {
      const to = str(meta, "toWorkflowName") ?? str(next, "workflowName");
      return to ? `moved the job to workflow ${quote(to)}` : "moved the job to another workflow";
    }
    case "job.stage_reattributed": {
      const to = str(meta, "toEditorName") ?? str(next, "editorName");
      return to ? `re-attributed the current stage to ${to}` : "re-attributed the current stage to the new editor";
    }

    /* ---------------- assignments ---------------- */
    case "assignment.created": {
      const role = str(next, "role") ?? "editor";
      const who = firstStr("userName", next, meta);
      const replacing = bag(prev).userId !== undefined && bag(prev).userId !== null;
      if (who) return replacing ? `reassigned the ${role} to ${who}` : `assigned ${who} as ${role}`;
      return replacing ? `reassigned the ${role}` : `assigned ${article(role)}`;
    }
    case "assignment.ended": {
      const role = str(prev, "role") ?? "editor";
      const who = firstStr("userName", prev, meta);
      const reason = str(meta, "unassignReason");
      const base = who ? `removed ${who} as ${role}` : `removed the ${role}`;
      return reason && reason !== "unassigned" ? `${base} (${humanise(reason).toLowerCase()})` : base;
    }

    /* ---------------- revisions ---------------- */
    case "revision.requested": {
      const n = num(next, "revisionNumber") ?? num(meta, "revisionNumber");
      const reason = str(next, "reason");
      const label = n ? `revision #${n}` : "a revision";
      return reason ? `requested ${label}: ${reason}` : `requested ${label}`;
    }
    case "revision.resolved": {
      const n = num(meta, "revisionNumber");
      const resolution = str(next, "resolution");
      const label = n ? `revision #${n}` : "the revision";
      return resolution ? `resolved ${label} (${humanise(resolution).toLowerCase()})` : `resolved ${label}`;
    }
    case "revision.withdrawn": {
      const n = num(meta, "revisionNumber");
      return n ? `withdrew revision #${n}` : "withdrew the revision";
    }
    case "revision.updated": {
      const n = num(meta, "revisionNumber");
      return `updated ${n ? `revision #${n}` : "the revision"}${changedFields(prev, next)}`;
    }

    /* ---------------- comments ---------------- */
    case "comment.added": {
      const kind = str(next, "kind");
      if (kind === "question") return "asked a question";
      if (kind === "clarification_request") return "asked for clarification";
      if (kind === "revision_response") return "responded to a revision";
      return str(next, "parentCommentId") ? "replied to a comment" : "commented";
    }
    case "comment.edited":
      return "edited a comment";
    case "comment.deleted":
      return "deleted a comment";
    case "comment.mentioned": {
      const who = firstStr("mentionedUserName", next, meta);
      return who ? `mentioned ${who} in a comment` : "mentioned a teammate in a comment";
    }

    /* ---------------- notes ---------------- */
    case "note.added":
      return `added ${article(noteKindLabel(firstStr("kind", next, meta)))}`;
    case "note.edited":
      return `edited ${article(noteKindLabel(firstStr("kind", next, prev, meta)))}`;
    case "note.archived":
      return `archived ${article(noteKindLabel(firstStr("kind", next, prev, meta)))}`;
    case "note.restored":
      return `restored ${article(noteKindLabel(firstStr("kind", next, prev, meta)))}`;

    /* ---------------- links ---------------- */
    case "link.added":
      return `added ${article(linkKindLabel(firstStr("kind", next, meta)))} link`;
    case "link.replaced":
      return `replaced the ${linkKindLabel(firstStr("kind", meta, next, prev))} link`;
    case "link.updated": {
      const before = firstStr("kind", prev);
      const after = firstStr("kind", next, meta);
      if (before && after && before !== after) return `moved a link from ${linkKindLabel(before)} to ${linkKindLabel(after)}`;
      return `relabelled the ${linkKindLabel(after ?? before)} link`;
    }
    case "link.removed": {
      const reason = str(meta, "reason");
      const base = `removed the ${linkKindLabel(firstStr("kind", prev, meta))} link`;
      return reason ? `${base}: ${reason}` : base;
    }

    /* ---------------- time tracking ---------------- */
    case "work_session.started":
      return "started the timer";
    case "work_session.ended": {
      const seconds = num(next, "durationSeconds");
      const reason = str(next, "endReason");
      const verb = reason === "paused" ? "paused the timer" : reason && reason.startsWith("auto_") ? "timer stopped automatically" : "stopped the timer";
      return seconds !== null ? `${verb} after ${formatDuration(seconds * 1000)}` : verb;
    }

    /* ---------------- users ---------------- */
    case "user.created": {
      const role = roleLabel(bag(next).role);
      return `invited ${targetName(prev, next, meta)}${role ? ` as ${role}` : ""}`;
    }
    case "user.updated":
      return `updated ${targetName(prev, next, meta)}’s profile${changedFields(prev, next)}`;
    case "user.role_changed": {
      const from = roleLabel(bag(prev).role);
      const to = roleLabel(bag(next).role) ?? "a new role";
      const who = targetName(prev, next, meta);
      return from ? `changed ${who}’s role from ${from} to ${to}` : `changed ${who}’s role to ${to}`;
    }
    case "user.deactivated":
      return `deactivated ${targetName(prev, next, meta)}`;
    case "user.reactivated":
      return `reactivated ${targetName(prev, next, meta)}`;
    case "user.password_changed":
      return bool(meta, "self") ? "changed their password" : `reset the password for ${targetName(prev, next, meta)}`;
    case "user.capacity_changed": {
      const from = num(prev, "capacityHoursPerWeek");
      const to = num(next, "capacityHoursPerWeek");
      const who = targetName(prev, next, meta);
      const fmt = (v: number | null) => (v === null ? "the default" : `${v} h/week`);
      return `changed ${who}’s capacity from ${fmt(from)} to ${fmt(to)}`;
    }
    case "user.flags_changed":
      return `changed ${targetName(prev, next, meta)}’s visibility settings${changedFields(prev, next)}`;
    case "user.anonymised":
      return "anonymised a former team member";
    case "user.workload_band_changed": {
      const from = bandLabel(prev);
      const to = bandLabel(next) ?? "a new band";
      const who = targetName(prev, next, meta);
      return from ? `flagged ${who}’s workload as ${to} (was ${from})` : `flagged ${who}’s workload as ${to}`;
    }
    case "user.notification_prefs_changed":
      return "updated notification preferences";

    /* ---------------- auth ---------------- */
    case "auth.logged_in":
      return "signed in";
    case "auth.login_failed": {
      const email = str(next, "email");
      return email ? `failed sign-in attempt for ${email}` : "failed sign-in attempt";
    }
    case "auth.logged_out":
      return "signed out";

    /* ---------------- teams ---------------- */
    case "team.created":
      return `created team ${entityName(prev, next, meta, "a team")}`;
    case "team.updated":
      return `updated team ${entityName(prev, next, meta, "a team")}${changedFields(prev, next)}`;
    case "team.archived":
      return `archived team ${entityName(prev, next, meta, "a team")}`;
    case "team.member_added": {
      const who = firstStr("userName", next, meta) ?? "a member";
      const team = firstStr("teamName", meta, next);
      return team ? `added ${who} to team ${quote(team)}` : `added ${who} to a team`;
    }
    case "team.member_removed": {
      const who = firstStr("userName", prev, next, meta) ?? "a member";
      const team = firstStr("teamName", meta, prev);
      return team ? `removed ${who} from team ${quote(team)}` : `removed ${who} from a team`;
    }

    /* ---------------- clients / projects ---------------- */
    case "client.created":
      return `created client ${entityName(prev, next, meta, "a client")}`;
    case "client.updated":
      return `updated client ${entityName(prev, next, meta, "a client")}${changedFields(prev, next)}`;
    case "client.archived":
      return `archived client ${entityName(prev, next, meta, "a client")}`;
    case "client.restored":
      return `restored client ${entityName(prev, next, meta, "a client")}`;
    case "project.created":
      return `created project ${entityName(prev, next, meta, "a project")}`;
    case "project.updated":
      return `updated project ${entityName(prev, next, meta, "a project")}${changedFields(prev, next)}`;
    case "project.archived":
      return `archived project ${entityName(prev, next, meta, "a project")}`;
    case "project.restored":
      return `restored project ${entityName(prev, next, meta, "a project")}`;

    /* ---------------- workflow admin ---------------- */
    case "workflow.created":
      return `created workflow ${entityName(prev, next, meta, "a workflow")}`;
    case "workflow.updated":
      return `updated workflow ${entityName(prev, next, meta, "a workflow")}${changedFields(prev, next)}`;
    case "workflow.archived":
      return `archived workflow ${entityName(prev, next, meta, "a workflow")}`;
    case "status.created":
      return `added status ${entityName(prev, next, meta, "a status")}`;
    case "status.updated":
      return `updated status ${entityName(prev, next, meta, "a status")}${changedFields(prev, next)}`;
    case "status.archived":
      return `archived status ${entityName(prev, next, meta, "a status")}`;
    case "status.reordered":
      return "reordered workflow statuses";
    case "workflow_transition.created":
    case "workflow_transition.updated":
    case "workflow_transition.archived": {
      const verb = eventType === "workflow_transition.created" ? "added" : eventType === "workflow_transition.updated" ? "updated" : "archived";
      const from = firstStr("fromStatusName", next, prev, meta);
      const to = firstStr("toStatusName", next, prev, meta);
      return from && to ? `${verb} the transition ${from} → ${to}` : `${verb} a workflow transition`;
    }
    case "job_type.created":
      return `created job type ${entityName(prev, next, meta, "a job type")}`;
    case "job_type.updated":
      return `updated job type ${entityName(prev, next, meta, "a job type")}${changedFields(prev, next)}`;
    case "job_type.archived":
      return `archived job type ${entityName(prev, next, meta, "a job type")}`;

    /* ---------------- automations ---------------- */
    case "automation.created":
      return `created automation ${entityName(prev, next, meta, "a rule")}`;
    case "automation.updated":
      return `updated automation ${entityName(prev, next, meta, "a rule")}`;
    case "automation.enabled":
      return `enabled automation ${entityName(prev, next, meta, "a rule")}`;
    case "automation.disabled":
      return `disabled automation ${entityName(prev, next, meta, "a rule")}`;
    case "automation.archived":
      return `archived automation ${entityName(prev, next, meta, "a rule")}`;
    case "automation.ran": {
      const name = firstStr("automationName", meta, next);
      const status = str(next, "status");
      return `ran automation${name ? ` ${quote(name)}` : ""}${status ? ` (${status})` : ""}`;
    }

    /* ---------------- settings / personalisation ---------------- */
    case "settings.updated": {
      const field = firstStr("field", next, prev);
      if (!field) return "updated organisation settings";
      return `changed ${humanise(field).toLowerCase()} from ${display(bag(prev).value)} to ${display(bag(next).value)}`;
    }
    case "notification.sent": {
      const type = str(next, "type");
      const label = type && type in NOTIFICATION_TYPE_META ? NOTIFICATION_TYPE_META[type as NotificationType].label.toLowerCase() : null;
      return label ? `sent a notification (${label})` : "sent a notification";
    }
    case "saved_view.created":
      return `saved view ${entityName(prev, next, meta, "a view")}`;
    case "saved_view.updated":
      return `updated view ${entityName(prev, next, meta, "a view")}`;
    case "saved_view.deleted":
      return `deleted view ${entityName(prev, next, meta, "a view")}`;
    case "dashboard.updated":
      return "rearranged the dashboard";

    default:
      return assertNever(eventType);
  }
}

/* ------------------------------------------------------------------ */
/*  Global feed sentence                                               */
/* ------------------------------------------------------------------ */

export interface FeedEventLike {
  eventType: string;
  summary: string;
  previousValue?: unknown;
  newValue?: unknown;
  metadata?: unknown;
  automationRunId?: string | null;
}

/** Job milestones rendered as "<actor> <verb> “<job>”" in the global feed. */
const FEED_JOB_VERBS: Partial<Record<EventType, string>> = {
  "job.created": "created",
  "job.accepted": "accepted",
  "job.declined": "declined",
  "job.work_started": "started work on",
  "job.paused": "paused work on",
  "job.resumed": "resumed work on",
  "job.review_started": "started reviewing",
  "job.approved": "approved",
  "job.delivered": "delivered",
  "job.completed": "completed",
  "job.cancelled": "cancelled",
  "job.reopened": "reopened",
  "job.restored": "restored",
};

/**
 * One feed line, e.g. `John completed “123 Smith Street”`, `Automation moved
 * “PJ-0142” to In Progress`, `Sarah commented on “PJ-0007 Smith St”`.
 * `actorName` null → "Automation" (automation run) or "System".
 */
export function describeEventForFeed(event: FeedEventLike, actorName: string | null, jobLabel: string | null): string {
  const automated = Boolean(event.automationRunId) || str(event.metadata, "cause") === "automation";
  const who = actorName ?? (automated ? "Automation" : "System");
  const type = event.eventType as EventType;
  const job = jobLabel ? quote(jobLabel) : null;

  if (job) {
    if (type === "job.became_overdue") return `${job} became overdue`;
    if (type === "job.review_overdue") return `Review of ${job} is overdue`;
    if (type === "job.status_changed") {
      const to = statusLabel(event.newValue);
      if (to) return `${who} moved ${job} to ${to}`;
    }
    if (type === "job.submitted") {
      return `${who} ${bool(event.metadata, "resubmission") ? "resubmitted" : "submitted"} ${job}`;
    }
    const verb = FEED_JOB_VERBS[type];
    if (verb) return `${who} ${verb} ${job}`;
    return `${who} ${event.summary} on ${job}`;
  }
  return `${who} ${event.summary}`;
}
