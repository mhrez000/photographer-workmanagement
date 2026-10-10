/**
 * Automation rules — CRUD (ARCHITECTURE.md §7, events §5 `automation.*`).
 *
 * `automation.manage` = admins (the system context is refused).
 * Every mutation: permission → Zod parse → org-scoped loads (404 for foreign
 * ids) → cross-field rules (`automationDefinitionProblems`, 400) → one write
 * → `automation.*` event (management visibility) in the same tx.
 * `expectedVersion` is optional and checked only when sent (409 + current row).
 * Rules are never deleted: archive instead (also disables them).
 *
 * Execution lives in ./automationEngine.ts; `dryRun` here only reads.
 */
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { automations, clients, jobTypes, type AutomationAction, type AutomationCondition, type AutomationTrigger } from "@/db/schema";
import { STAFF_ROLES } from "@/lib/constants";
import type { AuthContext, Automation, AutomationDryRunResult } from "@/lib/types";
import {
  ArchiveAutomationInput,
  CreateAutomationInput,
  DryRunAutomationInput,
  ToggleAutomationInput,
  UpdateAutomationInput,
  automationDefinitionProblems,
} from "@/lib/validation/automations";
import { AutomationActionsReadSchema, AutomationConditionsSchema, AutomationTriggerSchema, parseJsonColumn } from "@/lib/validation/json";
import { recordEvent } from "@/server/audit";
import { assertCan } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { loadAutomationInOrg, loadJobInOrg, loadUsersInOrg, one, parseInput, type DbLike, type Tx } from "./_shared";
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

/** JSON equality that ignores key order (jsonb normalises it on the way back). */
function sameJson(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
}

function definitionOf(row: Automation): Definition {
  return {
    trigger: parseJsonColumn(AutomationTriggerSchema, row.trigger, row.trigger),
    conditions: parseJsonColumn(AutomationConditionsSchema, row.conditions, []),
    actions: parseJsonColumn(AutomationActionsReadSchema, row.actions, []),
  };
}

/**
 * Cross-field rules + every referenced id belongs to the organisation
 * (users in notify / assign actions and editor / photographer conditions,
 * job types and clients in conditions). Foreign ids → 404.
 */
async function assertDefinition(db: DbLike, ctx: AuthContext, def: Definition): Promise<void> {
  const problems = automationDefinitionProblems(def.trigger, def.conditions, def.actions);
  if (problems.length > 0) throw ruleViolation(problems[0] ?? "Invalid automation", { problems });

  const userIds = new Set<string>();
  const editorTargets = new Set<string>();
  const notifyTargets = new Set<string>();
  for (const action of def.actions) {
    if (action.type === "notify" && action.target === "user" && action.userId) {
      userIds.add(action.userId);
      notifyTargets.add(action.userId);
    }
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

  const people = await loadUsersInOrg(db, ctx, [...userIds]);
  for (const user of people) {
    if (editorTargets.has(user.id) && (user.role !== "editor" || !user.isActive)) {
      throw ruleViolation(`${user.name} is not an active editor`, {}, "actions");
    }
    // Allow-list (docs/ROLES.md §3.4): automations only ever name staff (never client users).
    if (notifyTargets.has(user.id) && (!(STAFF_ROLES as readonly string[]).includes(user.role) || !user.isActive)) {
      throw ruleViolation(`${user.name} is not an active studio member`, {}, "actions");
    }
  }
  if (jobTypeIds.size > 0) {
    const found = await db
      .select({ id: jobTypes.id })
      .from(jobTypes)
      .where(and(inArray(jobTypes.id, [...jobTypeIds]), eq(jobTypes.organisationId, ctx.organisationId)));
    if (found.length !== jobTypeIds.size) throw new NotFoundError("Job type");
  }
  if (clientIds.size > 0) {
    const found = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(inArray(clients.id, [...clientIds]), eq(clients.organisationId, ctx.organisationId)));
    if (found.length !== clientIds.size) throw new NotFoundError("Client");
  }
}

function assertNotArchived(row: Automation): void {
  if (row.archivedAt !== null) throw ruleViolation("This automation is archived");
}

/** `POST /api/automations` */
export async function createAutomation(tx: Tx, ctx: AuthContext, input: unknown): Promise<Automation> {
  assertCan(ctx, "automation.manage");
  const data = parseInput(CreateAutomationInput, input);
  const def: Definition = { trigger: data.trigger, conditions: data.conditions, actions: data.actions };
  await assertDefinition(tx, ctx, def);
  if (!ctx.userId) throw new NotFoundError("User");

  const now = ctx.now();
  const sortOrder =
    data.sortOrder ??
    (await tx.select({ id: automations.id }).from(automations).where(eq(automations.organisationId, ctx.organisationId))).length;
  const row = await one(
    tx
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
      .returning(),
    "automation",
  );
  await recordEvent(tx, ctx, {
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
export async function updateAutomation(tx: Tx, ctx: AuthContext, input: unknown): Promise<Automation> {
  assertCan(ctx, "automation.manage");
  const data = parseInput(UpdateAutomationInput, input);
  const current = await loadAutomationInOrg(tx, ctx, data.automationId);
  checkVersion(current, data.expectedVersion, current);
  assertNotArchived(current);

  const existing = definitionOf(current);
  const def: Definition = {
    trigger: data.trigger ?? existing.trigger,
    conditions: data.conditions ?? existing.conditions,
    actions: data.actions ?? existing.actions,
  };
  await assertDefinition(tx, ctx, def);

  const patch: Partial<typeof automations.$inferInsert> = {};
  if (data.name !== undefined && data.name !== current.name) patch.name = data.name;
  if (data.description !== undefined && data.description !== current.description) patch.description = data.description;
  if (data.sortOrder !== undefined && data.sortOrder !== current.sortOrder) patch.sortOrder = data.sortOrder;
  if (data.trigger !== undefined && !sameJson(data.trigger, current.trigger)) {
    patch.trigger = def.trigger;
    patch.triggerType = def.trigger.type;
  }
  if (data.conditions !== undefined && !sameJson(data.conditions, current.conditions)) patch.conditions = def.conditions;
  if (data.actions !== undefined && !sameJson(data.actions, current.actions)) patch.actions = def.actions;
  if (Object.keys(patch).length === 0) return current;

  const [row] = await tx
    .update(automations)
    .set({ ...patch, version: current.version + 1, updatedAt: ctx.now() })
    .where(and(eq(automations.id, current.id), eq(automations.version, current.version)))
    .returning();
  if (!row) throw new NotFoundError("Automation");
  await recordEvent(tx, ctx, {
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
export async function toggleAutomation(tx: Tx, ctx: AuthContext, input: unknown): Promise<Automation> {
  assertCan(ctx, "automation.manage");
  const data = parseInput(ToggleAutomationInput, input);
  const current = await loadAutomationInOrg(tx, ctx, data.automationId);
  checkVersion(current, data.expectedVersion, current);
  assertNotArchived(current);
  const next = data.isEnabled ?? !current.isEnabled;
  if (next === current.isEnabled) return current;

  const [row] = await tx
    .update(automations)
    .set({ isEnabled: next, version: current.version + 1, updatedAt: ctx.now() })
    .where(and(eq(automations.id, current.id), eq(automations.version, current.version)))
    .returning();
  if (!row) throw new NotFoundError("Automation");
  await recordEvent(tx, ctx, {
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
export async function archiveAutomation(tx: Tx, ctx: AuthContext, input: unknown): Promise<Automation> {
  assertCan(ctx, "automation.manage");
  const data = parseInput(ArchiveAutomationInput, input);
  const current = await loadAutomationInOrg(tx, ctx, data.automationId);
  checkVersion(current, data.expectedVersion, current);
  if (current.archivedAt !== null) return current;

  const now = ctx.now();
  const [row] = await tx
    .update(automations)
    .set({ archivedAt: now, isEnabled: false, version: current.version + 1, updatedAt: now })
    .where(and(eq(automations.id, current.id), eq(automations.version, current.version)))
    .returning();
  if (!row) throw new NotFoundError("Automation");
  await recordEvent(tx, ctx, {
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
export async function dryRun(db: DbLike, ctx: AuthContext, input: unknown): Promise<AutomationDryRunResult> {
  assertCan(ctx, "automation.manage");
  const data = parseInput(DryRunAutomationInput, input);
  const automation = await loadAutomationInOrg(db, ctx, data.automationId);
  const job = await loadJobInOrg(db, ctx, data.jobId);
  return dryRunAutomation(db, ctx, automation, job, { triggerEventId: data.triggerEventId });
}
