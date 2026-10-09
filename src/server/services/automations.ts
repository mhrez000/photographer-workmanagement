/**
 * Automation rules — CRUD (ARCHITECTURE.md §7, events §5 `automation.*`).
 *
 * `automation.manage` = owner / manager (the system context is refused).
 * Every mutation: permission → Zod parse → org-scoped loads (404 for foreign
 * ids) → cross-field rules (`automationDefinitionProblems`, 400) → one write
 * → `automation.*` event (management visibility) in the same tx.
 * `expectedVersion` is optional and checked only when sent (409 + current row).
 * Rules are never deleted: archive instead (also disables them).
 *
 * Execution lives in ./automationEngine.ts; `dryRun` here only reads.
 */
import { and, eq, inArray } from "drizzle-orm";
import { automations, clients, jobTypes, type AutomationAction, type AutomationCondition, type AutomationTrigger } from "@/db/schema";
import type { AuthContext, Automation, AutomationDryRunResult } from "@/lib/types";
import {
  ArchiveAutomationInput,
  CreateAutomationInput,
  DryRunAutomationInput,
  ToggleAutomationInput,
  UpdateAutomationInput,
  automationDefinitionProblems,
} from "@/lib/validation/automations";
import { AutomationActionsSchema, AutomationConditionsSchema, AutomationTriggerSchema, parseJsonColumn } from "@/lib/validation/json";
import { recordEvent } from "@/server/audit";
import { assertCan } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { loadAutomationInOrg, loadJobInOrg, loadUsersInOrg, parseInput, type DbLike, type Tx } from "./_shared";
import { checkVersion, ruleViolation } from "./_admin";
import { dryRunAutomation } from "./automationEngine";

interface Definition {
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
}

/** Snapshot written to automation.* events (and what the summaries read: `name`). */
function snapshot(row: Pick<Automation, "name" | "description" | "trigger" | "conditions" | "actions" | "isEnabled" | "sortOrder">): Record<string, unknown> {
  return {
    name: row.name,
    description: row.description,
    trigger: row.trigger,
    conditions: row.conditions,
    actions: row.actions,
    isEnabled: row.isEnabled,
    sortOrder: row.sortOrder,
  };
}

function definitionOf(row: Automation): Definition {
  return {
    trigger: parseJsonColumn(AutomationTriggerSchema, row.trigger, row.trigger),
    conditions: parseJsonColumn(AutomationConditionsSchema, row.conditions, []),
    actions: parseJsonColumn(AutomationActionsSchema, row.actions, []),
  };
}

/**
 * Cross-field rules + every referenced id belongs to the organisation
 * (users in notify / assign actions and editor / photographer conditions,
 * job types and clients in conditions). Foreign ids → 404.
 */
function assertDefinition(db: DbLike, ctx: AuthContext, def: Definition): void {
  const problems = automationDefinitionProblems(def.trigger, def.conditions, def.actions);
  if (problems.length > 0) throw ruleViolation(problems[0] ?? "Invalid automation", { problems });

  const userIds = new Set<string>();
  const editorTargets = new Set<string>();
  for (const action of def.actions) {
    if (action.type === "notify" && action.target === "user" && action.userId) userIds.add(action.userId);
    if (action.type === "assign_editor" && action.target === "user" && action.userId) {
      userIds.add(action.userId);
      editorTargets.add(action.userId);
    }
  }
  const jobTypeIds = new Set<string>();
  const clientIds = new Set<string>();
  for (const c of def.conditions) {
    if ((c.field === "editorId" || c.field === "photographerId") && c.values) c.values.forEach((v) => userIds.add(v));
    if (c.field === "jobTypeId") c.values.forEach((v) => jobTypeIds.add(v));
    if (c.field === "clientId") c.values.forEach((v) => clientIds.add(v));
  }

  const people = loadUsersInOrg(db, ctx, [...userIds]);
  for (const user of people) {
    if (editorTargets.has(user.id) && (user.role !== "editor" || !user.isActive)) {
      throw ruleViolation(`${user.name} is not an active editor`, {}, "actions");
    }
  }
  if (jobTypeIds.size > 0) {
    const found = db
      .select({ id: jobTypes.id })
      .from(jobTypes)
      .where(and(inArray(jobTypes.id, [...jobTypeIds]), eq(jobTypes.organisationId, ctx.organisationId)))
      .all();
    if (found.length !== jobTypeIds.size) throw new NotFoundError("Job type");
  }
  if (clientIds.size > 0) {
    const found = db
      .select({ id: clients.id })
      .from(clients)
      .where(and(inArray(clients.id, [...clientIds]), eq(clients.organisationId, ctx.organisationId)))
      .all();
    if (found.length !== clientIds.size) throw new NotFoundError("Client");
  }
}

function assertNotArchived(row: Automation): void {
  if (row.archivedAt !== null) throw ruleViolation("This automation is archived");
}

/** `POST /api/automations` */
export function createAutomation(tx: Tx, ctx: AuthContext, input: unknown): Automation {
  assertCan(ctx, "automation.manage");
  const data = parseInput(CreateAutomationInput, input);
  const def: Definition = { trigger: data.trigger, conditions: data.conditions, actions: data.actions };
  assertDefinition(tx, ctx, def);
  if (!ctx.userId) throw new NotFoundError("User");

  const now = ctx.now();
  const sortOrder =
    data.sortOrder ??
    tx
      .select({ id: automations.id })
      .from(automations)
      .where(eq(automations.organisationId, ctx.organisationId))
      .all().length;
  const row = tx
    .insert(automations)
    .values({
      organisationId: ctx.organisationId,
      name: data.name,
      description: data.description ?? null,
      isEnabled: data.isEnabled,
      triggerType: def.trigger.type,
      trigger: def.trigger,
      conditions: def.conditions,
      actions: def.actions,
      sortOrder,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "automation",
    entityId: row.id,
    eventType: "automation.created",
    action: "created",
    previousValue: null,
    newValue: snapshot(row),
    metadata: { automationId: row.id, name: row.name },
  });
  return row;
}

/** `PATCH /api/automations/:id` — name, description, trigger, conditions, actions, order. */
export function updateAutomation(tx: Tx, ctx: AuthContext, input: unknown): Automation {
  assertCan(ctx, "automation.manage");
  const data = parseInput(UpdateAutomationInput, input);
  const current = loadAutomationInOrg(tx, ctx, data.automationId);
  checkVersion(current, data.expectedVersion, current);
  assertNotArchived(current);

  const existing = definitionOf(current);
  const def: Definition = {
    trigger: data.trigger ?? existing.trigger,
    conditions: data.conditions ?? existing.conditions,
    actions: data.actions ?? existing.actions,
  };
  assertDefinition(tx, ctx, def);

  const patch: Partial<typeof automations.$inferInsert> = {};
  if (data.name !== undefined && data.name !== current.name) patch.name = data.name;
  if (data.description !== undefined && data.description !== current.description) patch.description = data.description;
  if (data.sortOrder !== undefined && data.sortOrder !== current.sortOrder) patch.sortOrder = data.sortOrder;
  if (data.trigger !== undefined && JSON.stringify(data.trigger) !== JSON.stringify(current.trigger)) {
    patch.trigger = def.trigger;
    patch.triggerType = def.trigger.type;
  }
  if (data.conditions !== undefined && JSON.stringify(data.conditions) !== JSON.stringify(current.conditions)) patch.conditions = def.conditions;
  if (data.actions !== undefined && JSON.stringify(data.actions) !== JSON.stringify(current.actions)) patch.actions = def.actions;
  if (Object.keys(patch).length === 0) return current;

  const row = tx
    .update(automations)
    .set({ ...patch, version: current.version + 1, updatedAt: ctx.now() })
    .where(and(eq(automations.id, current.id), eq(automations.version, current.version)))
    .returning()
    .get();
  if (!row) throw new NotFoundError("Automation");
  recordEvent(tx, ctx, {
    entityType: "automation",
    entityId: row.id,
    eventType: "automation.updated",
    action: "updated",
    previousValue: snapshot(current),
    newValue: snapshot(row),
    metadata: { automationId: row.id, name: row.name, changedFields: Object.keys(patch).filter((k) => k !== "triggerType") },
  });
  return row;
}

/** `POST /api/automations/:id/toggle` — enable / disable (omitted `isEnabled` flips). */
export function toggleAutomation(tx: Tx, ctx: AuthContext, input: unknown): Automation {
  assertCan(ctx, "automation.manage");
  const data = parseInput(ToggleAutomationInput, input);
  const current = loadAutomationInOrg(tx, ctx, data.automationId);
  checkVersion(current, data.expectedVersion, current);
  assertNotArchived(current);
  const next = data.isEnabled ?? !current.isEnabled;
  if (next === current.isEnabled) return current;

  const row = tx
    .update(automations)
    .set({ isEnabled: next, version: current.version + 1, updatedAt: ctx.now() })
    .where(and(eq(automations.id, current.id), eq(automations.version, current.version)))
    .returning()
    .get();
  if (!row) throw new NotFoundError("Automation");
  recordEvent(tx, ctx, {
    entityType: "automation",
    entityId: row.id,
    eventType: next ? "automation.enabled" : "automation.disabled",
    action: "updated",
    previousValue: { name: current.name, isEnabled: current.isEnabled },
    newValue: { name: row.name, isEnabled: row.isEnabled },
    metadata: { automationId: row.id, name: row.name },
  });
  return row;
}

/** `POST /api/automations/:id/archive` — archives (and disables) the rule; its runs stay. */
export function archiveAutomation(tx: Tx, ctx: AuthContext, input: unknown): Automation {
  assertCan(ctx, "automation.manage");
  const data = parseInput(ArchiveAutomationInput, input);
  const current = loadAutomationInOrg(tx, ctx, data.automationId);
  checkVersion(current, data.expectedVersion, current);
  if (current.archivedAt !== null) return current;

  const now = ctx.now();
  const row = tx
    .update(automations)
    .set({ archivedAt: now, isEnabled: false, version: current.version + 1, updatedAt: now })
    .where(and(eq(automations.id, current.id), eq(automations.version, current.version)))
    .returning()
    .get();
  if (!row) throw new NotFoundError("Automation");
  recordEvent(tx, ctx, {
    entityType: "automation",
    entityId: row.id,
    eventType: "automation.archived",
    action: "archived",
    previousValue: { ...snapshot(current), archivedAt: null },
    newValue: { ...snapshot(row), archivedAt: row.archivedAt },
    metadata: { automationId: row.id, name: row.name },
  });
  return row;
}

/**
 * `POST /api/automations/:id/dry-run { jobId }` — evaluates trigger +
 * conditions against the job and previews the actions. Writes nothing
 * (accepts a Db or a Tx).
 */
export function dryRun(db: DbLike, ctx: AuthContext, input: unknown): AutomationDryRunResult {
  assertCan(ctx, "automation.manage");
  const data = parseInput(DryRunAutomationInput, input);
  const automation = loadAutomationInOrg(db, ctx, data.automationId);
  const job = loadJobInOrg(db, ctx, data.jobId);
  return dryRunAutomation(db, ctx, automation, job, { triggerEventId: data.triggerEventId });
}
