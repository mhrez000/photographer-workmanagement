/**
 * Automation enqueue (ARCHITECTURE.md §7) — the half of the engine that runs
 * INSIDE the human transaction.
 *
 * `enqueueAutomations(tx, ctx, event)` is called by `recordEvent()`
 * (src/server/audit.ts) for every event it writes: the single hook means no
 * service can forget to fire automations, and events written by automations
 * themselves (ctx.automationRunId) are chained with `depth = parent.depth + 1`.
 * It inserts one `automation_runs` row (status `pending`) per enabled,
 * non-archived rule whose trigger matches; `UNIQUE(automation_id,
 * trigger_event_id)` + ON CONFLICT DO NOTHING make it idempotent, so the
 * workflow engine's `emitAutomationEvent` hook may also point here safely.
 *
 * Execution happens after commit in ./automationEngine.ts. This module only
 * depends on the schema and constants so audit.ts can import it without an
 * import cycle through the services.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "@/db/index";
import { activityEvents, automationRuns, automations, workflowStatuses, type AutomationTrigger } from "@/db/schema";
import type { AutomationTriggerType, EventType } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { AutomationTriggerSchema } from "@/lib/validation/json";

/** An event that may trigger automations. Values are loaded from the row when omitted. */
export interface AutomationEventInput {
  eventId: string;
  eventType: EventType | string;
  jobId: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  /** The run that wrote the event (chain depth); defaults to ctx.automationRunId. */
  automationRunId?: string | null;
}

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Bag) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Deadline event type → `deadline_changed.field`. */
export const DEADLINE_EVENT_FIELDS: Readonly<Record<string, "dueDate" | "reviewDueDate" | "deliveryDueDate">> = {
  "job.due_date_changed": "dueDate",
  "job.review_due_date_changed": "reviewDueDate",
  "job.delivery_due_date_changed": "deliveryDueDate",
};

/** Event types that can fire some trigger (cheap pre-filter before any query). */
export const TRIGGER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "job.created",
  "job.status_changed",
  "assignment.created",
  ...Object.keys(DEADLINE_EVENT_FIELDS),
  "job.priority_changed",
  "revision.requested",
  "job.became_overdue",
  "user.workload_band_changed",
]);

/**
 * Trigger types an event can fire. `assignment.created` is `job_assigned`
 * when nobody held the role before and `job_reassigned` when someone did.
 */
export function triggerTypesForEvent(eventType: string, previousValue: unknown): AutomationTriggerType[] {
  switch (eventType) {
    case "job.created":
      return ["job_created"];
    case "job.status_changed":
      return ["status_changed"];
    case "assignment.created":
      return [str(bag(previousValue).userId) ? "job_reassigned" : "job_assigned"];
    case "job.due_date_changed":
    case "job.review_due_date_changed":
    case "job.delivery_due_date_changed":
      return ["deadline_changed"];
    case "job.priority_changed":
      return ["priority_changed"];
    case "revision.requested":
      return ["revision_requested"];
    case "job.became_overdue":
      return ["job_overdue"];
    case "user.workload_band_changed":
      return ["workload_threshold"];
    default:
      return [];
  }
}

export interface TriggerEventPayload {
  eventType: string;
  previousValue: unknown;
  newValue: unknown;
}

/**
 * True when the rule's trigger (type + filters) matches the event.
 * `statusKeyOf` resolves `newValue.statusId` → status key (status_changed.toStatusKey).
 */
export function triggerMatches(trigger: AutomationTrigger, event: TriggerEventPayload, statusKeyOf: (statusId: string) => string | null): boolean {
  if (!triggerTypesForEvent(event.eventType, event.previousValue).includes(trigger.type)) return false;
  const prev = bag(event.previousValue);
  const next = bag(event.newValue);
  switch (trigger.type) {
    case "job_created":
    case "revision_requested":
    case "job_overdue":
      return true;
    case "status_changed": {
      if (trigger.toCategory && next.category !== trigger.toCategory) return false;
      if (trigger.fromCategory && prev.category !== trigger.fromCategory) return false;
      if (trigger.toStatusKey) {
        const statusId = str(next.statusId);
        if (!statusId || statusKeyOf(statusId) !== trigger.toStatusKey) return false;
      }
      return true;
    }
    case "job_assigned":
    case "job_reassigned":
      return next.role === trigger.role;
    case "deadline_changed":
      return !trigger.field || DEADLINE_EVENT_FIELDS[event.eventType] === trigger.field;
    case "priority_changed":
      return !trigger.toPriority || next.priority === trigger.toPriority;
    case "workload_threshold":
      return next.band === trigger.band;
    default:
      return false;
  }
}

/**
 * Inserts one pending `automation_runs` row per enabled rule matching the
 * event (inside the caller's transaction). Returns the new run ids (empty
 * when nothing matched or the runs already existed).
 */
export async function enqueueAutomations(tx: Tx, ctx: AuthContext, event: AutomationEventInput): Promise<string[]> {
  if (!TRIGGER_EVENT_TYPES.has(event.eventType)) return [];

  let previousValue = event.previousValue;
  let newValue = event.newValue;
  if (previousValue === undefined || newValue === undefined) {
    const [row] = await tx
      .select({ previousValue: activityEvents.previousValue, newValue: activityEvents.newValue })
      .from(activityEvents)
      .where(and(eq(activityEvents.id, event.eventId), eq(activityEvents.organisationId, ctx.organisationId)));
    if (!row) return [];
    previousValue = row.previousValue;
    newValue = row.newValue;
  }

  const types = triggerTypesForEvent(event.eventType, previousValue);
  if (types.length === 0) return [];

  const rules = await tx
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.organisationId, ctx.organisationId),
        inArray(automations.triggerType, types),
        eq(automations.isEnabled, true),
        isNull(automations.archivedAt),
      ),
    )
    .orderBy(asc(automations.sortOrder), asc(automations.createdAt), asc(automations.id));
  if (rules.length === 0) return [];

  // triggerMatches() is synchronous: prefetch the only status key it can ask for
  // (newValue.statusId, for status_changed.toStatusKey filters).
  const statusKeys = new Map<string, string | null>();
  const candidateStatusId = str(bag(newValue).statusId);
  if (candidateStatusId) {
    const [row] = await tx
      .select({ key: workflowStatuses.key })
      .from(workflowStatuses)
      .where(and(eq(workflowStatuses.id, candidateStatusId), eq(workflowStatuses.organisationId, ctx.organisationId)));
    statusKeys.set(candidateStatusId, row?.key ?? null);
  }
  const statusKeyOf = (statusId: string): string | null => statusKeys.get(statusId) ?? null;

  const payload: TriggerEventPayload = { eventType: event.eventType, previousValue, newValue };
  const matching = rules.filter((rule) => {
    const parsed = AutomationTriggerSchema.safeParse(rule.trigger);
    return parsed.success && triggerMatches(parsed.data, payload, statusKeyOf);
  });
  if (matching.length === 0) return [];

  const parentRunId = event.automationRunId ?? ctx.automationRunId ?? null;
  let depth = 0;
  if (parentRunId) {
    const [parent] = await tx.select({ depth: automationRuns.depth }).from(automationRuns).where(eq(automationRuns.id, parentRunId));
    depth = (parent?.depth ?? 0) + 1;
  }

  const createdAt = ctx.now();
  const inserted = await tx
    .insert(automationRuns)
    .values(
      matching.map((rule) => ({
        organisationId: ctx.organisationId,
        automationId: rule.id,
        triggerEventId: event.eventId,
        jobId: event.jobId ?? null,
        depth,
        status: "pending" as const,
        conditionsSnapshot: rule.conditions,
        createdAt,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: automationRuns.id });
  return inserted.map((r) => r.id);
}
