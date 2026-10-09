/**
 * Human sentences for automation rules ("When status changes to Submitted →
 * notify the photographer"). Pure and server-safe: used by the rules list
 * (server) and the live preview in the builder (client).
 */
import { LINK_KIND_META, PRIORITY_META, STATUS_CATEGORY_META, WORKLOAD_BAND_META, type StatusCategory } from "@/lib/constants";
import type { AutomationListItem } from "@/lib/types";

export type AutomationTrigger = AutomationListItem["trigger"];
export type AutomationCondition = AutomationListItem["conditions"][number];
export type AutomationAction = AutomationListItem["actions"][number];

/** Optional id → name lookups so sentences show people/types/clients by name. */
export interface NameLookup {
  users?: Record<string, string>;
  jobTypes?: Record<string, string>;
  clients?: Record<string, string>;
}

const cat = (c: StatusCategory) => STATUS_CATEGORY_META[c]?.label ?? c;

function orList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

function names(ids: readonly string[] | undefined, map: Record<string, string> | undefined, fallback: string): string {
  if (!ids || ids.length === 0) return fallback;
  return orList(ids.map((id) => map?.[id] ?? "unknown"));
}

const DEADLINE_LABEL = { dueDate: "due date", reviewDueDate: "review deadline", deliveryDueDate: "delivery deadline" } as const;

export function describeTrigger(t: AutomationTrigger): string {
  switch (t.type) {
    case "job_created":
      return "When a job is created";
    case "status_changed": {
      let s = "When status changes";
      if (t.fromCategory) s += ` from ${cat(t.fromCategory)}`;
      if (t.toStatusKey) s += ` to “${t.toStatusKey}”`;
      else if (t.toCategory) s += ` to ${cat(t.toCategory)}`;
      return s;
    }
    case "job_assigned":
      return t.role === "editor" ? "When an editor is assigned" : "When a photographer is assigned";
    case "job_reassigned":
      return t.role === "editor" ? "When a job is reassigned to another editor" : "When the photographer changes";
    case "deadline_changed":
      return t.field ? `When the ${DEADLINE_LABEL[t.field]} changes` : "When any deadline changes";
    case "priority_changed":
      return t.toPriority ? `When priority changes to ${PRIORITY_META[t.toPriority].label}` : "When priority changes";
    case "revision_requested":
      return "When a revision is requested";
    case "job_overdue":
      return "When a job becomes overdue";
    case "workload_threshold":
      return `When an editor becomes ${WORKLOAD_BAND_META[t.band].label.toLowerCase()}`;
    default:
      return "When something happens";
  }
}

export function describeCondition(c: AutomationCondition, lookup: NameLookup = {}): string {
  switch (c.field) {
    case "priority":
      return `priority is ${orList(c.values.map((p) => PRIORITY_META[p].label))}`;
    case "statusCategory":
      return `status is ${orList(c.values.map(cat))}`;
    case "jobTypeId":
      return `job type is ${names(c.values, lookup.jobTypes, "…")}`;
    case "clientId":
      return `client is ${names(c.values, lookup.clients, "…")}`;
    case "editorId":
      if (c.op === "is_null") return "no editor is assigned";
      if (c.op === "is_not_null") return "an editor is assigned";
      return `editor is ${names(c.values, lookup.users, "…")}`;
    case "photographerId":
      return `photographer is ${names(c.values, lookup.users, "…")}`;
    case "revisionCount":
      return `revision count ${c.op === "gte" ? "≥" : "≤"} ${c.value}`;
    case "isOverdue":
      return c.value ? "the job is overdue" : "the job is not overdue";
    case "hasLinkKind":
      return `${c.op === "exists" ? "it has" : "it has no"} ${LINK_KIND_META[c.kind].label.toLowerCase()} link`;
    default:
      return "a condition holds";
  }
}

const TARGET_LABEL = {
  photographer: "the photographer",
  editor: "the editor",
  previous_editor: "the previous editor",
  creator: "whoever created the job",
  managers: "managers",
  owner: "the owner",
  user: "a chosen person",
} as const;

export function describeAction(a: AutomationAction, lookup: NameLookup = {}): string {
  switch (a.type) {
    case "notify": {
      const who = a.target === "user" ? (a.userId ? (lookup.users?.[a.userId] ?? "a chosen person") : "a chosen person") : TARGET_LABEL[a.target];
      return `notify ${who}`;
    }
    case "assign_editor":
      if (a.target === "previous_editor") return "assign back to the previous editor";
      if (a.target === "original_editor") return "assign back to the original editor";
      return `assign to ${a.userId ? (lookup.users?.[a.userId] ?? "a chosen editor") : "a chosen editor"}`;
    case "transition":
      return `move to ${cat(a.toCategory)}`;
    case "set_priority":
      return `set priority to ${PRIORITY_META[a.priority].label}`;
    case "add_note":
      return `add ${a.kind === "internal" ? "an" : "a"} ${a.kind} note`;
    default:
      return "do something";
  }
}

/** Full sentence: "When … if … and … → notify …, then …". */
export function describeRule(rule: { trigger: AutomationTrigger; conditions: readonly AutomationCondition[]; actions: readonly AutomationAction[] }, lookup: NameLookup = {}): {
  trigger: string;
  conditions: string | null;
  actions: string;
} {
  return {
    trigger: describeTrigger(rule.trigger),
    conditions: rule.conditions.length > 0 ? `if ${rule.conditions.map((c) => describeCondition(c, lookup)).join(" and ")}` : null,
    actions: rule.actions.map((a) => describeAction(a, lookup)).join(", then ") || "do nothing",
  };
}

