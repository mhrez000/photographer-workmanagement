/**
 * Organisation settings service (ARCHITECTURE.md §2.1, §5 settings.updated).
 * View: owner / manager (`settings.view`); change: owner only
 * (`settings.manage`). One `settings.updated` event per changed field
 * (`{field, value}` before/after). `last_overdue_sweep_at` is not editable
 * (audit exemption, written by the sweep).
 */
import { eq } from "drizzle-orm";
import { organisationSettings, organisations } from "@/db/schema";
import type { AuthContext, Organisation, OrganisationSettings } from "@/lib/types";
import { SETTINGS_FIELDS, UpdateSettingsInput } from "@/lib/validation/settings";
import { recordEvent } from "@/server/audit";
import { assertCan } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { first, parseInput, type DbLike, type Tx } from "./_shared";
import { checkVersion, ruleViolation } from "./_admin";

export interface SettingsView {
  organisation: Pick<Organisation, "id" | "name" | "slug">;
  settings: OrganisationSettings;
}

async function loadSettingsRow(db: DbLike, ctx: AuthContext): Promise<SettingsView> {
  const org = await first(db.select().from(organisations).where(eq(organisations.id, ctx.organisationId)));
  if (!org) throw new NotFoundError("Organisation");
  let settings = await first(db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, ctx.organisationId)));
  if (!settings) {
    // Every org is created with a settings row; this is a defensive fallback with column defaults.
    settings = { ...defaultSettingsRow(ctx.organisationId) };
  }
  return { organisation: { id: org.id, name: org.name, slug: org.slug }, settings };
}

function defaultSettingsRow(organisationId: string): OrganisationSettings {
  return {
    organisationId,
    timezone: "Australia/Sydney",
    weekStartsOn: 1,
    jobNumberPrefix: "PJ",
    timeTrackingEnabled: false,
    workSessionAutoTimeoutMinutes: 600,
    defaultCapacityHoursPerWeek: 38,
    defaultEstimatedHours: 2,
    workloadNearCapacityRatio: 0.7,
    workloadOverloadedRatio: 1,
    maxActiveJobsPerEditor: 12,
    reviewBottleneckHours: 24,
    reviewBottleneckMinJobs: 3,
    editingBottleneckDueWithinHours: 48,
    editingBottleneckMinDueSoon: 3,
    unassignedBacklogMin: 10,
    stalledDays: 5,
    revisionSpikeMinCount: 5,
    revisionSpikeMultiplier: 1.5,
    reviewSlaHours: 24,
    photographersSeeAllJobs: false,
    photographersSeeTeamJobs: true,
    editorsSeeTeamJobs: false,
    editorsSeeTeamWorkloads: false,
    automationsEnabled: true,
    auditNotifications: false,
    lastOverdueSweepAt: null,
    updatedAt: new Date(0).toISOString(),
    version: 0,
  };
}

/** Organisation + settings row (owner / manager). */
export async function getSettings(db: DbLike, ctx: AuthContext): Promise<SettingsView> {
  assertCan(ctx, "settings.view");
  return loadSettingsRow(db, ctx);
}

export interface UpdateSettingsResult extends SettingsView {
  changedFields: string[];
}

/** Owner only. Writes only the fields that changed, one event per field. */
export async function updateSettings(tx: Tx, ctx: AuthContext, input: unknown): Promise<UpdateSettingsResult> {
  assertCan(ctx, "settings.manage");
  const data = parseInput(UpdateSettingsInput, input);
  const current = await loadSettingsRow(tx, ctx);
  const row = current.settings;
  if (row.version > 0) checkVersion(row, data.expectedVersion, current);

  const changes: { field: string; previous: unknown; next: unknown }[] = [];
  const set: Partial<OrganisationSettings> = {};
  for (const field of SETTINGS_FIELDS) {
    const value = data[field];
    if (value === undefined || value === row[field]) continue;
    changes.push({ field, previous: row[field], next: value });
    (set as Record<string, unknown>)[field] = value;
  }
  const near = (set.workloadNearCapacityRatio ?? row.workloadNearCapacityRatio) as number;
  const over = (set.workloadOverloadedRatio ?? row.workloadOverloadedRatio) as number;
  if (near >= over) {
    throw ruleViolation("The near-capacity ratio must be below the overloaded ratio", {}, "workloadNearCapacityRatio");
  }
  const renamed = data.organisationName !== undefined && data.organisationName !== current.organisation.name;
  if (changes.length === 0 && !renamed) return { ...current, changedFields: [] };

  const now = ctx.now();
  if (changes.length > 0) {
    if (row.version === 0) {
      await tx.insert(organisationSettings).values({ ...row, ...set, updatedAt: now, version: 1 });
    } else {
      await tx
        .update(organisationSettings)
        .set({ ...set, updatedAt: now, version: row.version + 1 })
        .where(eq(organisationSettings.organisationId, ctx.organisationId));
    }
  }
  if (renamed) {
    await tx.update(organisations).set({ name: data.organisationName, updatedAt: now }).where(eq(organisations.id, ctx.organisationId));
    changes.unshift({ field: "organisationName", previous: current.organisation.name, next: data.organisationName });
  }
  for (const c of changes) {
    await recordEvent(tx, ctx, {
      entityType: "settings",
      entityId: ctx.organisationId,
      eventType: "settings.updated",
      action: "updated",
      previousValue: { field: c.field, value: c.previous },
      newValue: { field: c.field, value: c.next },
      metadata: { field: c.field },
    });
  }
  return { ...(await loadSettingsRow(tx, ctx)), changedFields: changes.map((c) => c.field) };
}
