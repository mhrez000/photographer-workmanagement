/**
 * Zod schemas for every JSON column (ARCHITECTURE.md §2.6). Applied on write
 * (services parse before insert) and on read (`parseJsonColumn` →
 * parse-or-fallback with a logged warning, so one bad row never breaks a page).
 *
 * Each schema is annotated with the TS type declared in src/db/schema.ts, so
 * the compiler fails if the two drift apart.
 */
import { z } from "zod";
import {
  DASHBOARD_WIDGET_TYPES,
  JOB_TABLE_COLUMNS,
  AUTOMATION_NOTE_KINDS,
  LINK_KINDS,
  NOTE_KINDS,
  PRIORITIES,
  STATUS_CATEGORIES,
  TRANSITION_ROLES,
  type TransitionRole,
} from "@/lib/constants";
import type {
  AutomationAction,
  AutomationActionResult,
  AutomationCondition,
  AutomationTrigger,
  DashboardLayout,
  Json,
  SavedViewConfig,
} from "@/db/schema";

/* ------------------------------------------------------------------ */
/*  Primitives                                                         */
/* ------------------------------------------------------------------ */

export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonSchema), z.record(z.string(), JsonSchema)]),
);

export const JsonObjectSchema: z.ZodType<Record<string, Json>> = z.record(z.string(), JsonSchema);

const id = z.string().min(1).max(64);
const statusCategory = z.enum(STATUS_CATEGORIES);
const priority = z.enum(PRIORITIES);

/** workflow_transitions.allowed_roles: non-empty subset of TRANSITION_ROLES (roles v2 §5.1; "client" is never a value). */
export const AllowedRolesSchema: z.ZodType<TransitionRole[]> = z.array(z.enum(TRANSITION_ROLES)).min(1);

/* ------------------------------------------------------------------ */
/*  Automations                                                        */
/* ------------------------------------------------------------------ */

export const AutomationTriggerSchema: z.ZodType<AutomationTrigger> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job_created") }),
  z.object({
    type: z.literal("status_changed"),
    toCategory: statusCategory.optional(),
    fromCategory: statusCategory.optional(),
    toStatusKey: z.string().min(1).max(64).optional(),
  }),
  z.object({ type: z.literal("job_assigned"), role: z.enum(["editor", "photographer"]) }),
  z.object({ type: z.literal("job_reassigned"), role: z.enum(["editor", "photographer"]) }),
  z.object({ type: z.literal("deadline_changed"), field: z.enum(["dueDate", "reviewDueDate", "deliveryDueDate"]).optional() }),
  z.object({ type: z.literal("priority_changed"), toPriority: priority.optional() }),
  z.object({ type: z.literal("revision_requested") }),
  z.object({ type: z.literal("job_overdue") }),
  z.object({ type: z.literal("workload_threshold"), band: z.enum(["near_capacity", "overloaded"]) }),
]);

export const AutomationConditionSchema: z.ZodType<AutomationCondition> = z.union([
  z.object({ field: z.literal("priority"), op: z.literal("in"), values: z.array(priority).min(1) }),
  z.object({ field: z.literal("statusCategory"), op: z.literal("in"), values: z.array(statusCategory).min(1) }),
  z.object({ field: z.literal("jobTypeId"), op: z.literal("in"), values: z.array(id).min(1) }),
  z.object({ field: z.literal("clientId"), op: z.literal("in"), values: z.array(id).min(1) }),
  z.object({ field: z.literal("editorId"), op: z.enum(["in", "is_null", "is_not_null"]), values: z.array(id).optional() }),
  z.object({ field: z.literal("photographerId"), op: z.literal("in"), values: z.array(id).min(1) }),
  z.object({ field: z.literal("revisionCount"), op: z.enum(["gte", "lte"]), value: z.number().int().min(0) }),
  z.object({ field: z.literal("isOverdue"), op: z.literal("eq"), value: z.boolean() }),
  z.object({ field: z.literal("hasLinkKind"), op: z.enum(["exists", "missing"]), kind: z.enum(LINK_KINDS) }),
]);

/** Notify targets accepted on WRITE (roles v2: "managers" / "owner" became "admins"). */
export const AUTOMATION_NOTIFY_TARGETS = ["photographer", "editor", "previous_editor", "creator", "admins", "user"] as const;
/** Legacy notify targets still found in frozen snapshots (automation_runs.actions_performed); read as "admins". */
export const LEGACY_AUTOMATION_NOTIFY_TARGETS = ["managers", "owner"] as const;

const assignEditorAction = z.object({
  type: z.literal("assign_editor"),
  target: z.enum(["previous_editor", "original_editor", "user"]),
  userId: id.optional(),
});
const transitionAction = z.object({ type: z.literal("transition"), toCategory: statusCategory, reason: z.string().max(500).optional() });
const setPriorityAction = z.object({ type: z.literal("set_priority"), priority });

/**
 * WRITE schema: only the roles-v2 notify targets; `add_note` cannot write a
 * client-visible `delivery` note (AUTOMATION_NOTE_KINDS, §6.3).
 */
export const AutomationActionSchema: z.ZodType<AutomationAction> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notify"),
    target: z.enum(AUTOMATION_NOTIFY_TARGETS),
    userId: id.optional(),
    message: z.string().max(500).optional(),
  }),
  assignEditorAction,
  transitionAction,
  setPriorityAction,
  z.object({ type: z.literal("add_note"), kind: z.enum(AUTOMATION_NOTE_KINDS), body: z.string().min(1).max(5000) }),
]);

/**
 * READ (parse-or-fallback) schema: also accepts the legacy "managers" / "owner"
 * targets (normalised to "admins") and any NOTE_KINDS value (frozen snapshots).
 * The engine must still refuse to EXECUTE a `delivery` note action.
 */
export const AutomationActionReadSchema: z.ZodType<AutomationAction> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notify"),
    target: z.enum([...AUTOMATION_NOTIFY_TARGETS, ...LEGACY_AUTOMATION_NOTIFY_TARGETS]).transform((t) =>
      t === "managers" || t === "owner" ? ("admins" as const) : t,
    ),
    userId: id.optional(),
    message: z.string().max(500).optional(),
  }),
  assignEditorAction,
  transitionAction,
  setPriorityAction,
  z.object({ type: z.literal("add_note"), kind: z.enum(NOTE_KINDS), body: z.string().min(1).max(5000) }),
]);

export const AutomationConditionsSchema = z.array(AutomationConditionSchema).max(20);
/** WRITE (create / update automation). */
export const AutomationActionsSchema = z.array(AutomationActionSchema).min(1).max(10);
/** READ of stored automations.actions (legacy targets normalised). */
export const AutomationActionsReadSchema = z.array(AutomationActionReadSchema).min(1).max(10);

/** automation_runs.actions_performed entries are frozen ledger rows: read with the legacy-tolerant schema. */
export const AutomationActionResultSchema: z.ZodType<AutomationActionResult> = z.object({
  action: AutomationActionReadSchema,
  ok: z.boolean(),
  detail: z.string().optional(),
  activityEventId: z.string().optional(),
});

export const AutomationActionResultsSchema = z.array(AutomationActionResultSchema);

/* ------------------------------------------------------------------ */
/*  Saved views / dashboards                                           */
/* ------------------------------------------------------------------ */

export const SavedViewConfigSchema: z.ZodType<SavedViewConfig> = z.object({
  filters: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.boolean(), z.null()])),
  sort: z.array(z.object({ column: z.string().min(1).max(64), dir: z.enum(["asc", "desc"]) })).max(5),
  groupBy: z.enum(["status", "editor", "photographer", "client", "priority", "dueDate", "jobType"]).nullable().optional(),
  columns: z.array(z.enum(JOB_TABLE_COLUMNS)),
  columnWidths: z.record(z.string(), z.number().min(0).max(2000)).optional(),
});

export const DashboardLayoutSchema: z.ZodType<DashboardLayout> = z.object({
  widgets: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        type: z.enum(DASHBOARD_WIDGET_TYPES),
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        w: z.number().int().min(1).max(12),
        h: z.number().int().min(1).max(24),
        settings: JsonObjectSchema.optional(),
      }),
    )
    .max(40),
});

/* ------------------------------------------------------------------ */
/*  Read-side helper                                                   */
/* ------------------------------------------------------------------ */

/**
 * Parse a JSON column value (already-decoded object, or a raw JSON string)
 * with `schema`; on failure log a warning and return `fallback`.
 */
export function parseJsonColumn<T>(schema: z.ZodType<T>, raw: unknown, fallback: T): T {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      console.warn("[json-column] invalid JSON text; using fallback");
      return fallback;
    }
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  console.warn(`[json-column] value failed validation; using fallback\n${z.prettifyError(result.error)}`);
  return fallback;
}
