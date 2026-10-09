/**
 * Human event-type groups for the activity filters (spec §37 "filter by
 * event"). Pure module: used by the /activity page (server) to expand a
 * group selection into `eventType[]`, and by the filter bar (client).
 */
import type { EventType } from "@/lib/constants";

export interface ActivityEventGroup {
  key: string;
  label: string;
  description: string;
  types: readonly EventType[];
  /** Only meaningful for owners / managers (events are management-visibility). */
  management?: boolean;
}

export const ACTIVITY_EVENT_GROUPS: readonly ActivityEventGroup[] = [
  {
    key: "status",
    label: "Status & workflow",
    description: "Status moves, starts, submissions, approvals, completions",
    types: [
      "job.status_changed", "job.accepted", "job.declined", "job.work_started", "job.paused", "job.resumed", "job.submitted",
      "job.review_started", "job.approved", "job.delivered", "job.completed", "job.cancelled", "job.reopened", "job.restored",
      "job.workflow_migrated", "job.stage_reattributed",
    ],
  },
  { key: "created", label: "Jobs created", description: "New jobs", types: ["job.created"] },
  { key: "assignments", label: "Assignments", description: "Editors and photographers assigned or removed", types: ["assignment.created", "assignment.ended"] },
  {
    key: "deadlines",
    label: "Deadlines & priority",
    description: "Due dates, shoot dates, priority, overdue flags",
    types: [
      "job.due_date_changed", "job.review_due_date_changed", "job.delivery_due_date_changed", "job.shoot_date_changed",
      "job.priority_changed", "job.became_overdue", "job.review_overdue",
    ],
  },
  { key: "edits", label: "Job edits", description: "Name, client, project, type, hours, completion", types: ["job.field_changed"] },
  { key: "revisions", label: "Revisions", description: "Requested, resolved, withdrawn", types: ["revision.requested", "revision.resolved", "revision.withdrawn", "revision.updated"] },
  { key: "comments", label: "Comments", description: "Comments, edits, mentions", types: ["comment.added", "comment.edited", "comment.deleted", "comment.mentioned"] },
  { key: "notes", label: "Notes", description: "Notes added, edited, archived", types: ["note.added", "note.edited", "note.archived", "note.restored"] },
  { key: "links", label: "Links", description: "Work links added, replaced, removed", types: ["link.added", "link.replaced", "link.removed"] },
  { key: "time", label: "Time tracking", description: "Timers started and stopped", types: ["work_session.started", "work_session.ended"] },
  {
    key: "structure",
    label: "Clients & projects",
    description: "Created, edited, archived",
    types: ["client.created", "client.updated", "client.archived", "client.restored", "project.created", "project.updated", "project.archived", "project.restored"],
  },
  {
    key: "people",
    label: "People & teams",
    description: "Invites, roles, capacity, teams, sign-ins",
    management: true,
    types: [
      "user.created", "user.updated", "user.role_changed", "user.deactivated", "user.reactivated", "user.password_changed",
      "user.capacity_changed", "user.flags_changed", "user.anonymised", "user.workload_band_changed", "user.notification_prefs_changed",
      "team.created", "team.updated", "team.archived", "team.member_added", "team.member_removed",
      "auth.logged_in", "auth.login_failed", "auth.logged_out",
    ],
  },
  {
    key: "admin",
    label: "Settings & automations",
    description: "Workflows, job types, automations, settings",
    management: true,
    types: [
      "workflow.created", "workflow.updated", "workflow.archived", "status.created", "status.updated", "status.archived", "status.reordered",
      "workflow_transition.created", "workflow_transition.updated", "workflow_transition.archived",
      "job_type.created", "job_type.updated", "job_type.archived",
      "automation.created", "automation.updated", "automation.enabled", "automation.disabled", "automation.archived", "automation.ran",
      "settings.updated", "notification.sent",
    ],
  },
];

const GROUP_BY_KEY = new Map(ACTIVITY_EVENT_GROUPS.map((g) => [g.key, g]));

/** Groups the viewer may filter by. */
export function eventGroupsFor(canSeeManagement: boolean): ActivityEventGroup[] {
  return ACTIVITY_EVENT_GROUPS.filter((g) => canSeeManagement || !g.management);
}

/** Expands group keys into the event types they cover (unknown keys ignored). */
export function eventTypesForGroups(keys: readonly string[]): EventType[] {
  const out = new Set<EventType>();
  for (const key of keys) for (const t of GROUP_BY_KEY.get(key)?.types ?? []) out.add(t);
  return [...out];
}

/** The group an event type belongs to (for the row icon / tone). */
export function groupOfEventType(type: string): ActivityEventGroup | null {
  for (const g of ACTIVITY_EVENT_GROUPS) if ((g.types as readonly string[]).includes(type)) return g;
  return null;
}
