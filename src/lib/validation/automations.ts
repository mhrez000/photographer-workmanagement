/**
 * Zod inputs for automation rules (ARCHITECTURE.md §7) and the cross-field
 * checks shared by create / update (`automationDefinitionProblems`).
 *
 * The JSON column shapes themselves (trigger / conditions / actions) live in
 * ./json.ts so reads and writes use the same schema.
 */
import { z } from "zod";
import type { AutomationAction, AutomationCondition, AutomationTrigger } from "@/db/schema";
import { AutomationActionsSchema, AutomationConditionsSchema, AutomationTriggerSchema } from "./json";
import { ExpectedVersionSchema, IdSchema, NameSchema, OptionalTextSchema } from "./admin-shared";

export const AUTOMATION_NAME_MAX = 120;
export const AUTOMATION_DESCRIPTION_MAX = 1000;

/** Action types that need a job (everything except `notify`). */
export const JOB_ONLY_ACTION_TYPES: ReadonlySet<AutomationAction["type"]> = new Set(["assign_editor", "transition", "set_priority", "add_note"]);

/**
 * Cross-field rules a rule definition must satisfy (empty = valid):
 *   - notify / assign_editor with target "user" need a userId
 *   - editorId "in" needs at least one value
 *   - workload_threshold has no job: no conditions, notify actions only,
 *     and no job-relative notify targets
 */
export function automationDefinitionProblems(
  trigger: AutomationTrigger,
  conditions: readonly AutomationCondition[],
  actions: readonly AutomationAction[],
): string[] {
  const problems: string[] = [];
  actions.forEach((action, i) => {
    const label = `Action ${i + 1}`;
    if (action.type === "notify" && action.target === "user" && !action.userId) problems.push(`${label}: choose the user to notify`);
    if (action.type === "assign_editor" && action.target === "user" && !action.userId) problems.push(`${label}: choose the editor to assign`);
  });
  conditions.forEach((c, i) => {
    if (c.field === "editorId" && c.op === "in" && (!c.values || c.values.length === 0)) {
      problems.push(`Condition ${i + 1}: choose at least one editor`);
    }
  });
  if (trigger.type === "workload_threshold") {
    if (conditions.length > 0) problems.push("Workload triggers are not about a job, so they cannot have job conditions");
    actions.forEach((action, i) => {
      if (JOB_ONLY_ACTION_TYPES.has(action.type)) problems.push(`Action ${i + 1}: workload triggers can only send notifications`);
      else if (action.type === "notify" && ["photographer", "previous_editor", "creator"].includes(action.target)) {
        problems.push(`Action ${i + 1}: workload triggers can notify the editor, managers, the owner or a chosen user`);
      }
    });
  }
  return problems;
}

export const CreateAutomationInput = z.object({
  name: NameSchema(AUTOMATION_NAME_MAX),
  description: OptionalTextSchema(AUTOMATION_DESCRIPTION_MAX),
  trigger: AutomationTriggerSchema,
  conditions: AutomationConditionsSchema.default([]),
  actions: AutomationActionsSchema,
  isEnabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CreateAutomationInputValue = z.output<typeof CreateAutomationInput>;

export const UpdateAutomationInput = z.object({
  automationId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  name: NameSchema(AUTOMATION_NAME_MAX).optional(),
  description: OptionalTextSchema(AUTOMATION_DESCRIPTION_MAX),
  trigger: AutomationTriggerSchema.optional(),
  conditions: AutomationConditionsSchema.optional(),
  actions: AutomationActionsSchema.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type UpdateAutomationInputValue = z.output<typeof UpdateAutomationInput>;

/** `POST /api/automations/:id/toggle` — omitted `isEnabled` flips the current value. */
export const ToggleAutomationInput = z.object({
  automationId: IdSchema,
  isEnabled: z.boolean().optional(),
  expectedVersion: ExpectedVersionSchema,
});
export type ToggleAutomationInputValue = z.output<typeof ToggleAutomationInput>;

export const ArchiveAutomationInput = z.object({
  automationId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
});
export type ArchiveAutomationInputValue = z.output<typeof ArchiveAutomationInput>;

/**
 * `POST /api/automations/:id/dry-run { jobId }` — evaluates trigger +
 * conditions against the job and lists the actions without writing.
 * `triggerEventId` pins the event to test against (default: the job's latest
 * event that maps to the rule's trigger type).
 */
export const DryRunAutomationInput = z.object({
  automationId: IdSchema,
  jobId: IdSchema,
  triggerEventId: IdSchema.optional(),
});
export type DryRunAutomationInputValue = z.output<typeof DryRunAutomationInput>;
